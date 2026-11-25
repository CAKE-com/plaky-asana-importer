import { assertEnvFileNotSymlink, parseServerEnv, type ServerEnv } from "./env-schema";
import { registerSecret } from "./redact";

export { assertEnvFileNotSymlink, parseServerEnv, startupRefusal, PLAKY_WEB_ADDRESS, PLAKY_WEB_ADDRESS_HINT, normalizeWebAddress, type ServerEnv } from "./env-schema";

assertEnvFileNotSymlink();
export const env: ServerEnv = parseServerEnv(process.env);
for (const name of ["ASANA_ACCESS_TOKEN", "PLAKY_API_KEY"]) registerSecret(process.env[name]);
