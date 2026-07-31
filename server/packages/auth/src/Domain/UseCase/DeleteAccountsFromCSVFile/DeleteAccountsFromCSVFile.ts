import { Result, UseCaseInterface, Username } from '@standardnotes/domain-core'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { CSVFileReaderInterface } from '../../CSV/CSVFileReaderInterface'
import { DeleteAccountsFromCSVFileDTO } from './DeleteAccountsFromCSVFileDTO'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

export class DeleteAccountsFromCSVFile implements UseCaseInterface<void> {
  constructor(
    private csvFileReader: CSVFileReaderInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private userRepository: UserRepositoryInterface,
    private logger: Logger,
  ) {}

  async execute(dto: DeleteAccountsFromCSVFileDTO): Promise<Result<void>> {
    const emailsOrError = await this.csvFileReader.getValues(dto.fileName)
    if (emailsOrError.isFailed()) {
      return Result.fail(emailsOrError.getError())
    }
    const emails = emailsOrError.getValue()

    if (emails.length === 0) {
      return Result.fail(`No emails found in CSV file ${dto.fileName}`)
    }

    if (dto.dryRun) {
      this.logger.info('Account-deletion CSV dry run completed.', {
        accountCount: emails.length,
      })

      return Result.ok()
    }

    for (const email of emails) {
      const usernameOrError = Username.create(email)
      if (usernameOrError.isFailed()) {
        return Result.fail(usernameOrError.getError())
      }
      const username = usernameOrError.getValue()

      const users = await this.userRepository.findAllByUsernameOrEmail(username)
      for (const user of users) {
        await this.domainEventPublisher.publish(
          this.domainEventFactory.createAccountDeletionVerificationRequestedEvent({
            userUuid: user.uuid,
            email: user.email,
          }),
        )
      }
    }

    return Result.ok()
  }
}
