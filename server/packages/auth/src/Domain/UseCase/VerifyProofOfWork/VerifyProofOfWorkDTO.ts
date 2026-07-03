import { ProofOfWorkScope } from '../../ProofOfWork/ProofOfWorkConfig'

export interface VerifyProofOfWorkDTO {
  scope: ProofOfWorkScope
  seed: unknown
  nonce: unknown
}
