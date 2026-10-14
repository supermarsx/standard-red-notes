import { action, makeAutoObservable, observable } from 'mobx'
import { TwoFactorActivation } from './TwoFactorActivation'
import { MfaServiceInterface, SessionsClientInterface } from '@standardnotes/snjs'

type TwoFactorStatus = 'two-factor-enabled' | TwoFactorActivation | 'two-factor-disabled'
type TwoFactorDisplayStatus = TwoFactorStatus | 'fetching' | 'unavailable'

export const is2FADisabled = (status: TwoFactorDisplayStatus): status is 'two-factor-disabled' =>
  status === 'two-factor-disabled'

export const is2FAActivation = (status: TwoFactorDisplayStatus): status is TwoFactorActivation =>
  (status as TwoFactorActivation)?.type === 'two-factor-activation'

export const is2FAEnabled = (status: TwoFactorDisplayStatus): status is 'two-factor-enabled' =>
  status === 'two-factor-enabled'

export class TwoFactorAuth {
  private _status: TwoFactorStatus | 'fetching' | 'unavailable' = 'fetching'
  private _errorMessage: string | null

  constructor(
    private readonly sessions: SessionsClientInterface,
    private readonly mfa: MfaServiceInterface,
    private callback?: (status: TwoFactorStatus) => void,
  ) {
    this._errorMessage = null

    makeAutoObservable<TwoFactorAuth, '_status' | '_errorMessage' | 'deactivateMfa' | 'startActivation'>(
      this,
      {
        _status: observable,
        _errorMessage: observable,
        deactivateMfa: action,
        startActivation: action,
      },
      { autoBind: true },
    )
  }

  private startActivation(): void {
    const setDisabled = action(() => (this._status = 'two-factor-disabled'))
    const setEnabled = action(() => {
      this._status = 'two-factor-enabled'
      this.fetchStatus()
    })
    this.mfa
      .generateMfaSecret()
      .then(
        action((secret) => {
          this._status = new TwoFactorActivation(
            this.mfa,
            this.sessions.getUser()?.email as string,
            secret,
            setDisabled,
            setEnabled,
          )
        }),
      )
      .catch(
        action((e) => {
          this.setError(e.message)
        }),
      )
  }

  private deactivate2FA(): void {
    this.mfa
      .disableMfa()
      .then(
        action(() => {
          this.fetchStatus()
        }),
      )
      .catch(
        action((e) => {
          this.setError(e.message)
        }),
      )
  }

  isLoggedIn(): boolean {
    return this.sessions.getUser() != undefined
  }

  fetchStatus(): void {
    if (!this.isLoggedIn()) {
      return
    }
    this._status = 'fetching'

    this.mfa
      .isMfaActivated()
      .then(
        action((active) => {
          this._status = active ? 'two-factor-enabled' : 'two-factor-disabled'
          this.setError(null)
          if (this.callback) {
            this.callback(this._status)
          }
        }),
      )
      .catch(
        action(() => {
          this._status = 'unavailable'
          this.setError('Could not check two-factor authentication. Retry when your connection is available.')
        }),
      )
  }

  private setError(errorMessage: string | null): void {
    this._errorMessage = errorMessage
  }

  toggle2FA(): void {
    if (!this.isLoggedIn()) {
      return
    }

    if (this._status === 'two-factor-disabled') {
      return this.startActivation()
    }

    if (this._status === 'two-factor-enabled') {
      return this.deactivate2FA()
    }
  }

  get errorMessage(): string | null {
    return this._errorMessage
  }

  get status(): TwoFactorStatus | 'fetching' | 'unavailable' {
    return this._status
  }
}
