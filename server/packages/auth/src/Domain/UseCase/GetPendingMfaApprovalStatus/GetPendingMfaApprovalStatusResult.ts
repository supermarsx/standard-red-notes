export interface GetPendingMfaApprovalStatusResult {
  // 'pending' while awaiting a trusted session; 'approved' exactly once (then
  // consumed); 'denied' or 'expired' are terminal failures.
  status: 'pending' | 'approved' | 'denied' | 'expired'
}
