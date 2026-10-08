export interface AppDeployConfig {
  composePath: string;
  service: string;
  image: string;
  healthCheckUrl: string;
  healthCheckTimeout: number;
  rollbackOnFailure: boolean;
}

const deployConfig: Record<string, AppDeployConfig> = {};

export default deployConfig;
