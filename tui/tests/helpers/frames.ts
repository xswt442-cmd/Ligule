// 只读取同步输出标记完整的一帧，避免把尚未写完的下一帧当作最终画面。
// 去除 ANSI 样式控制码后，断言只检查终端中可见的文本。
export function completeFrame(value: string): string {
  const closed = value.lastIndexOf('\x1B[?2026l');
  return closed < 0 ? '' : (value.slice(0, closed).split('\x1B[?2026h').pop() ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
