export interface AppDeployConfig {
  composePath: string;
  service: string;
  image: string;
  healthCheckUrl: string;
  healthCheckTimeout: number;
  rollbackOnFailure: boolean;
}

// Apps are normally registered on the server with `vigil app add`, which stores them
// in apps.json. Anything added here is built into the image and can't be changed
// without rebuilding, so it's only useful when you run VigilOps from source.
const deployConfig: Record<string, AppDeployConfig> = {};

export default deployConfig;
