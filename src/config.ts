export interface Config {
  photonProjectId: string;
  photonProjectSecret: string;
  databaseUrl: string;
  autoReply: boolean;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig(): Config {
  return {
    photonProjectId: required("PHOTON_PROJECT_ID"),
    photonProjectSecret: required("PHOTON_PROJECT_SECRET"),
    databaseUrl: required("DATABASE_URL"),
    autoReply: process.env.BOROUGHOS_AUTOREPLY !== "false",
  };
}
