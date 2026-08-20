import { Result, SharedVaultListingInterface, TrustedContactInterface } from '@standardnotes/snjs'

export type ContactInviteSelection = {
  uuid: string
  permission: string
}

export type ContactInviteFailure = {
  contactName: string
  message: string
}

export type SendContactInvitesResult = {
  sentContactUuids: string[]
  failures: ContactInviteFailure[]
}

type InviteFunction = (
  vault: SharedVaultListingInterface,
  contact: TrustedContactInterface,
  permission: string,
) => Promise<Result<unknown>>

const UnknownContactLabel = 'Unknown contact'

function labelForContact(contact: TrustedContactInterface): string {
  return contact.name || contact.contactUuid || UnknownContactLabel
}

function messageForThrownError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  if (typeof error === 'string' && error.length > 0) {
    return error
  }

  return 'An unexpected error occurred.'
}

/**
 * Invites every selected contact, recording per-contact outcomes instead of discarding them.
 *
 * Most ways an invite can fail (missing account keypair, missing key system root key, no `isMe`
 * contact for the vault, an unencryptable recipient public key) abort inside the use case before
 * any request is issued and only ever surfaced as a `Result` failure the caller previously ignored.
 * Never throws: a rejection from one contact must not skip the contacts queued behind it.
 */
export async function sendContactInvites(params: {
  vault: SharedVaultListingInterface
  selectedContacts: readonly ContactInviteSelection[]
  contacts: readonly TrustedContactInterface[]
  invite: InviteFunction
}): Promise<SendContactInvitesResult> {
  const sentContactUuids: string[] = []
  const failures: ContactInviteFailure[] = []

  for (const selected of params.selectedContacts) {
    const contact = params.contacts.find((candidate) => candidate.uuid === selected.uuid)
    if (!contact) {
      failures.push({
        contactName: UnknownContactLabel,
        message: 'This contact is no longer available to invite.',
      })
      continue
    }

    try {
      const result = await params.invite(params.vault, contact, selected.permission)
      if (result.isFailed()) {
        failures.push({ contactName: labelForContact(contact), message: result.getError() })
        continue
      }

      sentContactUuids.push(selected.uuid)
    } catch (error) {
      failures.push({ contactName: labelForContact(contact), message: messageForThrownError(error) })
    }
  }

  return { sentContactUuids, failures }
}

export function describeContactInviteFailures(result: SendContactInvitesResult): string {
  const total = result.sentContactUuids.length + result.failures.length
  const heading =
    result.sentContactUuids.length > 0
      ? `${result.failures.length} of ${total} invites could not be sent:`
      : result.failures.length === 1
        ? 'The invite could not be sent:'
        : 'None of the invites could be sent:'

  const details = result.failures.map((failure) => `${failure.contactName}: ${failure.message}`).join('\n')

  return `${heading}\n\n${details}`
}
