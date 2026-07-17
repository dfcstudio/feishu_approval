/** PostgreSQL text/varchar values cannot contain the NUL character. */
export const sanitizeDatabaseText = (value?: string | null): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return value.replace(/\u0000/gu, "");
};
