import type { HostProvider } from '../../dist/host/provider.js';

/** 测试用 HostProvider：补齐 Host 必需的字段，with* 原样返回同一具替身，只覆盖传入的部分。 */
export function testHostProvider(overrides: Partial<HostProvider> & Pick<HostProvider, 'stream'>): HostProvider {
  const provider: HostProvider = {
    name: 'test-provider',
    model: 'test-model',
    withModel: () => provider,
    withGeneration: () => provider,
    ...overrides,
  };
  return provider;
}
