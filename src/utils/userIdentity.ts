/** Values returned by approval personnel controls are sometimes IDs without a label. */
export const isLikelyUserId = (value?: string | null): boolean => {
  const normalized = value?.trim() ?? "";
  if (!normalized) return false;
  if (/^(?:ou|on|oc|u|user)_[A-Za-z0-9_-]+$/u.test(normalized)) return true;
  return normalized.length >= 8
    && /^[A-Za-z0-9_-]+$/u.test(normalized)
    && /\d/u.test(normalized);
};
