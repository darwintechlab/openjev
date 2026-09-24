import { OpenJevPlugin } from "./src/plugin.js";

export { OpenJevPlugin, OpenJev, Jev } from "./src/plugin.js";
export * from "./src/client.js";
export { loadDotEnv, dotEnvPaths, type DotEnvResult } from "./src/dotenv.js";

/**
 * opencode >=1.18 reads a plugin package's default export. It accepts either a
 * bare plugin function (legacy) or a `{ id, server }` module (v2). We use the
 * module form because this package also exports helpers/constants, and the
 * legacy loader iterates every export and throws "Plugin export is not a
 * function" as soon as it hits a non-function value.
 */
export default { id: "openjev", server: OpenJevPlugin };
