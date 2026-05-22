export interface AppDeployConfig {
  composePath: string;
  service: string;
  image: string;
  healthCheckUrl: string;
  healthCheckTimeout: number;
  rollbackOnFailure: boolean;
}

const deployConfig: Record<string, AppDeployConfig> = {
  'token-radar': {
    composePath: '/opt/token-radar/docker-compose.yml',
    service: 'app',
    image: 'ghcr.io/rytiva/token-radar',
    healthCheckUrl: 'https://app.tokenradarhq.xyz/health',
    healthCheckTimeout: 60,
    rollbackOnFailure: true,
  },

  // add more apps here
};

export default deployConfig;
