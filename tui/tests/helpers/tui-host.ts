import { withTuiHost as withCanonicalHost } from '../../../core/tests/helpers/tui-host.ts';
import type { TuiHostContext, TuiHostOptions } from '../../../core/tests/helpers/tui-host.ts';

export { measuredPermissionContext, waitFor } from '../../../core/tests/helpers/tui-host.ts';
export type { TuiHostContext, TuiHostOptions, TuiHostSetupPaths } from '../../../core/tests/helpers/tui-host.ts';

// TUI tests drive trusted-UI controls unless a case opts out explicitly.
export function withTuiHost<TResult>(
  run: (context: TuiHostContext) => TResult | Promise<TResult>,
  options: TuiHostOptions = {},
): Promise<TResult> {
  return withCanonicalHost(run, { permissionControl: true, ...options });
}
