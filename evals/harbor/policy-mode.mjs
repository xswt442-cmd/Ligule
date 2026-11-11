// 既有 Terminal-Bench 计划固定使用 `never`，因为其任务容器没有人能回答审批。
// 新计划可以显式使用 `auto`，由正常 Policy 链判定，并仍在运行前显式信任任务目录。
export const BENCHMARK_POLICY_MODE = 'never';

export function policyModeFromPlan(value) {
  if (value === undefined) return BENCHMARK_POLICY_MODE;
  if (value === 'auto') return value;
  throw new Error('benchmark_policy_mode_invalid');
}

export function policyModeForCli(value) {
  if (value === undefined) return BENCHMARK_POLICY_MODE;
  if (value === 'auto' || value === 'never') return value;
  throw new Error('benchmark_policy_mode_invalid');
}
