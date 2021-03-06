import * as c from "ansi-colors";
import * as childProcess from "child_process";
import * as fs from "fs-extra";
import * as deepExtend from "deep-extend";
import * as clone from "clone";
import * as prettyHrtime from "pretty-hrtime";
import * as util from "util";
import * as path from "path";
import {Utils} from "./utils";

const exec = util.promisify(childProcess.exec);

export class Job {
    public readonly name: string;
    public readonly needs: string[] | null;
    public readonly dependencies: string[] | null;
    public readonly stage: string;
    public readonly maxJobNameLength: number;
    public readonly stageIndex: number;
    public readonly environment?: { name: string, url: string|null };
    public readonly image: string | null;
    public readonly jobId: number;
    public readonly artifacts?: { paths: string[] };
    public readonly afterScripts: string[] = [];
    public readonly beforeScripts: string[] = [];
    public readonly cwd: string;
    public readonly scripts: string[] = [];
    public readonly rules?: { if: string, when: string, allow_failure: boolean }[];
    public readonly expandedVariables: { [key: string]: string };
    public readonly allowFailure: boolean;
    public readonly when: string;
    public readonly description: string;

    get preScriptsExitCode() { return this._prescriptsExitCode }
    private _prescriptsExitCode = 0;

    get afterScriptsExitCode() { return this._afterScriptsExitCode }
    private _afterScriptsExitCode = 0;

    private containerId: string|null = null;
    private started = false;
    private finished = false;
    private running = false;
    private success = true;

    constructor(jobData: any, name: string, stages: string[], cwd: string, globals: any, pipelineIid: number, jobId: number, maxJobNameLength: number, gitlabUser: { [key: string]: string }) {
        this.maxJobNameLength = maxJobNameLength;
        this.name = name;
        this.cwd = cwd;
        this.jobId = jobId;
        this.description = jobData['description'] || "";

        // Parse extends recursively and deepExtend data.
        if (jobData.extends) {
            jobData.extends = typeof jobData.extends === "string" ? [ jobData.extends ] : jobData.extends;
            let i;
            let clonedData: any = clone(jobData);
            const maxDepth = 50;
            for (i = 0; i < maxDepth; i++) {
                const parentDatas = []
                if (!clonedData.extends) {
                    break;
                }

                for (const parentName of clonedData.extends) {
                    const parentData = globals[parentName];
                    if (!parentData) {
                        process.stderr.write(`${c.blueBright(parentName)} is used by ${c.blueBright(name)}, but is unspecified\n`)
                        process.exit(1);
                    }
                    parentDatas.push(clone(globals[parentName]));
                }

                delete clonedData.extends;
                clonedData = deepExtend.apply(this, parentDatas.concat(clonedData));
            }
            if (i === maxDepth) {
                process.stderr.write(`You seem to have an infinite extends loop starting from ${c.blueBright(name)}\n`)
                process.exit(1);
            }

            jobData = clonedData;
        }

        // If the stage name is not set, it should default to "test", see:
        // https://docs.gitlab.com/ee/ci/yaml/#configuration-parameters
        this.stage = jobData.stage || "test";
        this.stageIndex = stages.indexOf(this.stage);

        const ciDefault = globals.default || {};
        this.when = jobData.when || "on_success";
        this.allowFailure = jobData.allow_failure || false;
        this.scripts = [].concat(jobData.script || []);
        this.beforeScripts = [].concat(jobData.before_script || ciDefault.before_script || globals.before_script || []);
        this.afterScripts = [].concat(jobData.after_script || ciDefault.after_script || globals.after_script || []);
        this.image = jobData.image || ciDefault.image || globals.image || null;
        this.artifacts = jobData.artifacts || ciDefault.artifacts || globals.artifacts || null;
        this.needs = jobData.needs || null;
        this.dependencies = jobData.dependencies || null;
        this.rules = jobData.rules || null;
        this.environment = typeof jobData.environment === "string" ? { name: jobData.environment} : jobData.environment;

        if (this.scripts.length === 0) {
            process.stderr.write(`${this.getJobNameString()} ${c.red("must have script specified")}\n`);
            process.exit(1);
        }

        const predefinedVariables = {
            GITLAB_USER_LOGIN: gitlabUser["GITLAB_USER_LOGIN"] || "local",
            GITLAB_USER_EMAIL: gitlabUser["GITLAB_USER_EMAIL"] || "local@gitlab.com",
            GITLAB_USER_NAME: gitlabUser["GITLAB_USER_NAME"] || "Bob Local",
            CI_COMMIT_SHORT_SHA: "a33bd89c", // Changes
            CI_COMMIT_SHA: "a33bd89c7b8fa3567524525308d8cafd7c0cd2ad",
            CI_PROJECT_NAME: "local-project",
            CI_PROJECT_TITLE: "LocalProject",
            CI_PROJECT_PATH_SLUG: "group/sub/local-project",
            CI_PROJECT_NAMESPACE: "group/sub/LocalProject",
            CI_COMMIT_REF_PROTECTED: "false",
            CI_COMMIT_BRANCH: "local/branch", // Branch name, only when building branches
            CI_COMMIT_REF_NAME: "local/branch", // Tag or branch name
            CI_PROJECT_VISIBILITY: "internal",
            CI_PROJECT_ID: "1217",
            CI_COMMIT_REF_SLUG: "local-branch",
            CI_COMMIT_TITLE: "Commit Title", // First line of commit message.
            CI_COMMIT_MESSAGE: "Commit Title\nMore commit text", // Full commit message
            CI_COMMIT_DESCRIPTION: "More commit text",
            CI_PIPELINE_SOURCE: "push",
            CI_JOB_ID: `${this.jobId}`, // Changes on rerun
            CI_PIPELINE_ID: `${pipelineIid + 1000}`,
            CI_PIPELINE_IID: `${pipelineIid}`,
            CI_SERVER_URL: "https://gitlab.com",
            CI_PROJECT_URL: "https://gitlab.com/group/sub/local-project",
            CI_JOB_URL: `https://gitlab.com/group/sub/local-project/-/jobs/${this.jobId}`, // Changes on rerun.
            CI_PIPELINE_URL: `https://gitlab.cego.dk/group/sub/local-project/pipelines/${pipelineIid}`,
            CI_JOB_NAME: `${this.name}`,
            CI_JOB_STAGE: `${this.stage}`,
            GITLAB_CI: "false",
        };

        // Create expanded variables
        const envs = {...globals.variables || {}, ...jobData.variables || {}, ...predefinedVariables, ...process.env}
        const expandedGlobalVariables = Utils.expandVariables(globals.variables || {}, envs)
        const expandedJobVariables = Utils.expandVariables(jobData.variables || {}, envs);
        this.expandedVariables = {...expandedGlobalVariables, ...expandedJobVariables, ...predefinedVariables};

        // Set {when, allowFailure} based on rules result
        if (this.rules) {
            const ruleResult = Utils.getRulesResult(this.rules, this.expandedVariables);
            this.when = ruleResult.when;
            this.allowFailure = ruleResult.allowFailure
        }

    }

    private async initEnvFile() {
        const envFile = `${this.cwd}/.gitlab-ci-local/envs/.env-${this.name}`;
        await fs.ensureFile(envFile);
        await fs.truncate(envFile);

        // Append expanded variales to .env file
        for (const [key, value] of Object.entries(this.expandedVariables)) {
            await fs.appendFile(envFile, `${key}=${JSON.stringify(value).substr(1).slice(0, -1)}\n`);
        }
    }

    private getContainerName() {
        return `gitlab-ci-local-job-${this.name.replace(/[^a-zA-Z0-9_.-]/g, '-')}`
    }

    private async pullImage() {
        if (!this.image) return;

        try {
            const imagePlusTag = this.image.includes(':') ? this.image : `${this.image}:latest`;
            return await exec(`docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '${imagePlusTag}'`, {env: this.expandedVariables});
        } catch (e) {
            process.stdout.write(`${this.getJobNameString()} ${c.cyanBright(`pulling ${this.image}`)}\n`)
            return await exec(`docker pull ${this.image}`, {env: this.expandedVariables});
        }
    }

    private async removeContainer(containerId: string|null) {
        if (!this.image) return;
        if (!containerId) return;
        await exec(`docker rm -f ${containerId}`, {env: this.expandedVariables});
    }

    private async copyArtifactsToHost() {
        if (!this.artifacts || !this.image) {
            return;
        }

        const containerName = this.getContainerName();

        for (let artifactPath of this.artifacts.paths || []) {
            artifactPath = Utils.expandText(artifactPath, this.expandedVariables);
            const source = `${containerName}:/gcl-wrk/${artifactPath}`
            const target = `${this.cwd}/${path.dirname(artifactPath)}`;
            await fs.promises.mkdir(target, { recursive: true });
            await exec(`docker cp ${source} ${target}`);
        }
    }

    async start(): Promise<void> {
        const startTime = process.hrtime();

        this.running = true;
        this.started = true;

        await fs.ensureFile(this.getOutputFilesPath());
        await fs.truncate(this.getOutputFilesPath());
        process.stdout.write(`${this.getStartingString()} ${this.image ? c.magentaBright("in docker...") : c.magentaBright("in shell...")}\n`);

        await this.pullImage();

        const prescripts = this.beforeScripts.concat(this.scripts);
        this._prescriptsExitCode = await this.execScripts(prescripts);
        if (this.afterScripts.length === 0 && this._prescriptsExitCode > 0 && !this.allowFailure) {
            process.stderr.write(`${this.getExitedString(startTime, this._prescriptsExitCode, false)}\n`);
            this.running = false;
            this.finished = true;
            this.success = false;
            await this.removeContainer(this.containerId);
            return;
        }

        if (this.afterScripts.length === 0 && this._prescriptsExitCode > 0 && this.allowFailure) {
            process.stderr.write(`${this.getExitedString(startTime, this._prescriptsExitCode, true)}\n`);
            this.running = false;
            this.finished = true;
            await this.removeContainer(this.containerId);
            return;
        }

        if (this._prescriptsExitCode > 0 && this.allowFailure) {
            process.stderr.write(`${this.getExitedString(startTime, this._prescriptsExitCode, true)}\n`);
        }

        if (this._prescriptsExitCode > 0 && !this.allowFailure) {
            process.stderr.write(`${this.getExitedString(startTime, this._prescriptsExitCode, false)}\n`);
        }

        this._afterScriptsExitCode = 0;
        if (this.afterScripts.length > 0) {
            this._afterScriptsExitCode = await this.execScripts(this.afterScripts);
        }

        if (this._afterScriptsExitCode > 0) {
            process.stderr.write(`${this.getExitedString(startTime, this._afterScriptsExitCode, true, " (after_script)")}\n`);
        }

        if (this._prescriptsExitCode > 0 && !this.allowFailure) {
            this.success = false;
        }

        await this.copyArtifactsToHost();
        await this.removeContainer(this.containerId);

        process.stdout.write(`${this.getFinishedString(startTime)}\n`);

        this.running = false;
        this.finished = true;

        return;
    }

    private async execScripts(scripts: string[]): Promise<number> {
        const jobName = this.name;
        const scriptPath = `${this.cwd}/.gitlab-ci-local/shell/${jobName}.sh`;

        await fs.ensureFile(scriptPath);
        await fs.chmod(scriptPath, '777');
        await fs.truncate(scriptPath);

        await fs.appendFile(scriptPath, `#!/bin/sh\n`);
        await fs.appendFile(scriptPath, `set -e\n\n`);

        for (const line of scripts) {
            // Print command echo'ed in color
            const split = line.split(/\r?\n/);
            const multilineText = split.length > 1 ? ' # collapsed multi-line command' : '';
            const text = split[0].replace(/["]/g, `\\"`).replace(/[$]/g, `\\$`);
            await fs.appendFile(scriptPath, `echo "${c.green(`\$ ${text}${multilineText}`)}"\n`);

            // Print command to execute
            await fs.appendFile(scriptPath, `${line}\n`);
        }

        await this.initEnvFile();

        if (this.image) {
            // Generate custom entrypoint
            const entrypointPath = `${this.cwd}/.gitlab-ci-local/entrypoint/${jobName}.sh`;
            await fs.ensureFile(entrypointPath);
            await fs.chmod(entrypointPath, '777');
            await fs.truncate(entrypointPath);
            await fs.appendFile(entrypointPath, `#!/bin/sh\n`);
            await fs.appendFile(entrypointPath, `set -e\n\n`);
            const result = await exec(`docker inspect ${this.image} --format "{{ .Config.Entrypoint }}"`);
            const originalEntrypoint = result.stdout.slice(1,-2);
            if (originalEntrypoint !== '') {
                await fs.appendFile(entrypointPath, `${originalEntrypoint}\n`);
            }
            await fs.appendFile(entrypointPath, `exec "$@"\n`);

            const envFile = `${this.cwd}/.gitlab-ci-local/envs/.env-${this.name}`
            const {stdout} = await exec(`docker create -w /gcl-wrk/ --env-file ${envFile} --entrypoint "./gitlab-ci-local-entrypoint-${this.name}.sh" --name ${this.getContainerName()} ${this.image} ./gitlab-ci-local-shell-${this.name}`);
            this.containerId = stdout ? stdout.replace(/\r?\n/g, '') : null;
            await exec(`docker cp ${entrypointPath} ${this.getContainerName()}:/gcl-wrk/gitlab-ci-local-entrypoint-${this.name}.sh`);
            await exec(`docker cp ${scriptPath} ${this.getContainerName()}:/gcl-wrk/gitlab-ci-local-shell-${this.name}`);
            await exec(`docker cp ${this.cwd}/. ${this.getContainerName()}:/gcl-wrk/.`);

            return await this.executeCommandHandleOutputStreams(`docker start --attach ${this.getContainerName()}`);
        }
        return await this.executeCommandHandleOutputStreams(scriptPath);
    }

    private async executeCommandHandleOutputStreams(command: string): Promise<number> {
        const jobNameStr = this.getJobNameString();
        const outputFilesPath = this.getOutputFilesPath();
        const outFunc = (e: any, stream: NodeJS.WriteStream, colorize: (str: string) => string) => {
            for (const line of `${e}`.split(/\r?\n/)) {
                if (line.length === 0) continue;
                stream.write(`${jobNameStr} `);
                if (!line.startsWith('\u001b[32m$')) {
                    stream.write(`${colorize(">")} `);
                }
                stream.write(`${line}\n`);
                fs.appendFileSync(outputFilesPath, `${line}\n`);
            }
        }

        return new Promise((resolve, reject) => {
            const p = childProcess.exec(`${command}`, { env: {...this.expandedVariables, ...process.env}, cwd: this.cwd });

            if (p.stdout) {
                p.stdout.on("data", (e) => outFunc(e, process.stdout, (s) => c.greenBright(s)));
            }
            if (p.stderr) {
                p.stderr.on("data", (e) => outFunc(e, process.stderr, (s) => c.redBright(s)));
            }

            p.on("error", (err) => reject(err));
            p.on("close", (signal) => resolve(signal ? signal : 0));
        });
    }

    private getExitedString(startTime: [number, number], code: number, warning = false, prependString = "") {
        const finishedStr = this.getFinishedString(startTime);
        if (warning) {
            return `${finishedStr} ${c.yellowBright(`warning with code ${code}`)} ${prependString}`;
        }

        return `${finishedStr} ${c.red(`exited with code ${code}`)} ${prependString}`;
    }

    private getFinishedString(startTime: [number, number]) {
        const endTime = process.hrtime(startTime);
        const timeStr = prettyHrtime(endTime);
        const jobNameStr = this.getJobNameString();

        return `${jobNameStr} ${c.magentaBright("finished")} in ${c.magenta(`${timeStr}`)}`;
    }

    private getStartingString() {
        const jobNameStr = this.getJobNameString();

        return `${jobNameStr} ${c.magentaBright("starting")}`;
    }

    getJobNameString() {
        return `${c.blueBright(`${this.name.padEnd(this.maxJobNameLength)}`)}`;
    }

    getOutputFilesPath() {
        return `${this.cwd}/.gitlab-ci-local/output/${this.name}.log`;
    }

    isFinished() {
        return this.finished;
    }

    isStarted() {
        return this.started;
    }

    isManual() {
        return this.when === "manual";
    }

    isNever() {
        return this.when === "never";
    }

    isRunning() {
        return this.running;
    }

    isSuccess() {
        return this.success;
    }

    setFinished(finished: boolean) {
        this.finished = finished;
    }
}
