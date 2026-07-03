import { ProofOfWorkScope } from '../../ProofOfWork/ProofOfWorkConfig'

export interface RequestProofOfWorkChallengeDTO {
  scope: ProofOfWorkScope
  difficulty: number
  ttlSeconds: number
}
