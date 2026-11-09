/** Types for the benchmark policy constant shared by the JS exporter and the TS runner. */
export declare const BENCHMARK_POLICY_MODE: 'never';
export declare function policyModeFromPlan(value: unknown): 'never' | 'auto';
export declare function policyModeForCli(value: unknown): 'never' | 'auto';
