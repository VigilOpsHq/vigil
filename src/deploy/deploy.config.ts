
export interface AppDeployConfig {
  composePath: string;        // absolute path to docker-compose.yml on the VPS
  service: string;            // the service name inside the compose file
  image: string;              // full image name e.g. ghcr.io/yourorg/app
  healthCheckUrl: string;     // URL Vigil polls after deploy to verify it's alive
  healthCheckTimeout: number; // seconds to wait before declaring deploy failed
  rollbackOnFailure: boolean;
}

const deployConfig: Record<string, AppDeployConfig> = {
  // Replace these examples with your actual apps.
  // The key (e.g. "my-api") is what you use in /deploy and webhook calls.

  // 'my-api': {
  //   composePath: '/opt/my-api/docker-compose.yml',
  //   service: 'app',
  //   image: 'ghcr.io/yourorg/my-api',
  //   healthCheckUrl: 'https://api.yourdomain.com/health',
  //   healthCheckTimeout: 60,
  //   rollbackOnFailure: true,
  // },

  // 'my-frontend': {
  //   composePath: '/opt/my-frontend/docker-compose.yml',
  //   service: 'web',
  //   image: 'ghcr.io/yourorg/my-frontend',
  //   healthCheckUrl: 'https://yourdomain.com',
  //   healthCheckTimeout: 30,
  //   rollbackOnFailure: true,
  // },
};

export default deployConfig;
