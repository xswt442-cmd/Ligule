// 基准任务里没有人可以回答审批：`ask` 会在第一次需要放行时以 ask_unavailable 结束，
// 于是被测的是审批通道而不是 Agent 能力。基准固定用 `never`，并在运行前显式信任任务目录
// （见 export_session.mjs 的 ensureWorkspaceTrust）。这两项都是评测声明，不是给产品用的默认值。
export const BENCHMARK_POLICY_MODE = 'never';
