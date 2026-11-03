export function withoutAutoInheritanceMarker(acl: string): string {
  return acl.replaceAll('(I)', '');
}
