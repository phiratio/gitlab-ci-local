import * as fs from "fs-extra";
import * as yaml from "js-yaml";

import { Parser } from "./parser";

const getPipelineIid = async (cwd: string) => {
    const stateFile = `${cwd}/.gitlab-ci-local/state.yml`;
    const ymlData = await Parser.loadYaml(stateFile);

    return ymlData["pipelineIid"] || 0;
};

const incrementPipelineIid = async (cwd: string) => {
    const stateFile = `${cwd}/.gitlab-ci-local/state.yml`;
    const ymlData = await Parser.loadYaml(stateFile);

    ymlData["pipelineIid"] = ymlData["pipelineIid"] !== undefined ? ymlData["pipelineIid"] + 1 : 0;
    await fs.outputFile(stateFile, yaml.dump(ymlData));
};

const getJobId = async (cwd: string) => {
    const stateFile = `${cwd}/.gitlab-ci-local/state.yml`;
    const ymlData = await Parser.loadYaml(stateFile);

    return ymlData["jobId"] || 0;
};

const incrementJobId = async (cwd: string) => {
    const stateFile = `${cwd}/.gitlab-ci-local/state.yml`;
    const ymlData = await Parser.loadYaml(stateFile);

    ymlData["jobId"] = ymlData["jobId"] !== undefined ? ymlData["jobId"] + 1 : 100000;
    await fs.outputFile(stateFile, yaml.dump(ymlData));
};

export { getPipelineIid, incrementPipelineIid, getJobId, incrementJobId };
