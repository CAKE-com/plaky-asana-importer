import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const EFFECTS_BANNED =
  "Effects are banned in this codebase. Derive the value during render; do the work in the event handler that causes it; for server " +
  "state use TanStack Query (enabled, refetchInterval, a query key that changes, onSuccess/onSettled on mutations); for timers, window " +
  "events or storage use useSyncExternalStore; for DOM subscriptions a ref callback that returns its cleanup; to reset, remount with a " +
  "key; for a one-time initial value, a lazy useState initialiser.";

const QUERY_FN = "CallExpression[callee.name=/^use(Suspense)?Query$/] > ObjectExpression > Property[key.name='queryFn'] > :matches(ArrowFunctionExpression, FunctionExpression)";
const QUERY_FN_RETURNS_NOTHING = `${QUERY_FN}[body.type='BlockStatement']:not(:has(ReturnStatement[argument]))`;
const QUERY_FN_RETURNS_VOID = `${QUERY_FN} > UnaryExpression.body[operator='void']`;
const QUERY_FN_MUST_READ =
  "A query's queryFn must return the data it reads. A query that exists to run a callback is an effect: do the work in the event handler " +
  "or the mutation that causes it.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "react", importNames: ["useEffect", "useLayoutEffect", "useInsertionEffect"], message: EFFECTS_BANNED }],
      }],
      "no-restricted-syntax": ["error",
        { selector: "MemberExpression[property.name=/^use(Layout|Insertion)?Effect$/]", message: EFFECTS_BANNED },
        { selector: "ObjectPattern > Property[key.name=/^use(Layout|Insertion)?Effect$/]", message: EFFECTS_BANNED },
        { selector: QUERY_FN_RETURNS_NOTHING, message: QUERY_FN_MUST_READ },
        { selector: QUERY_FN_RETURNS_VOID, message: QUERY_FN_MUST_READ },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "tmp/**",
    "data/**",
  ]),
]);

export default eslintConfig;
