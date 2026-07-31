import { readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const packageRoot = resolve(__dirname, '../..')
const runtimeRoots = [resolve(packageRoot, 'src'), resolve(packageRoot, 'bin')]
const coordinatorPath = resolve(packageRoot, 'src/Infra/TypeORM/AuthTypeORMTransactionCoordinator.ts')
const forbiddenCallNames = new Set([
  'transaction',
  'createQueryRunner',
  'startTransaction',
  'commitTransaction',
  'rollbackTransaction',
])

interface RuntimeSource {
  path: string
  source: string
}

const productionTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return productionTypeScriptFiles(path)
    }

    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : []
  })

const calledName = (expression: ts.LeftHandSideExpression): string | undefined => {
  if (ts.isIdentifier(expression)) {
    return expression.text
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression
    return argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
      ? argument.text
      : undefined
  }

  return undefined
}

const findForbiddenCalls = (files: RuntimeSource[]): string[] => {
  const offenders: string[] = []

  for (const file of files) {
    if (resolve(file.path) === coordinatorPath) {
      continue
    }
    const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calledName(node.expression)
        if (name && forbiddenCallNames.has(name)) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile))
          offenders.push(`${relative(packageRoot, file.path)}:${position.line + 1}:${position.character + 1}:${name}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return offenders
}

describe('auth TypeORM transaction entry-point contract', () => {
  it('routes every explicit src/bin runtime transaction through the shared coordinator', () => {
    const runtimeFiles = runtimeRoots.flatMap(productionTypeScriptFiles).map((path) => ({
      path,
      source: readFileSync(path, 'utf8'),
    }))

    expect(runtimeRoots.map((path) => basename(path))).toEqual(['src', 'bin'])
    expect(findForbiddenCalls(runtimeFiles)).toEqual([])

    const backupRepository = readFileSync(
      resolve(packageRoot, 'src/Infra/TypeORM/TypeORMNextcloudBackupStateRepository.ts'),
      'utf8',
    )
    const userRepository = readFileSync(resolve(packageRoot, 'src/Infra/TypeORM/TypeORMUserRepository.ts'), 'utf8')
    expect(backupRepository).toContain('runAuthTypeORMTransaction(this.dataSource')
    expect(userRepository).toContain('runAuthTypeORMTransaction(this.ormRepository.manager.connection')
  })

  it.each([
    ['dot call', 'manager.transaction(async () => undefined)'],
    ['optional call', 'manager?.createQueryRunner?.()'],
    ['bracket call', "manager['startTransaction']()"],
    ['optional bracket call', 'manager?.[`commitTransaction`]?.()'],
    ['aliased call', 'const { rollbackTransaction } = manager; rollbackTransaction()'],
  ])('detects a synthetic %s mutation', (_description, source) => {
    expect(
      findForbiddenCalls([
        {
          path: resolve(packageRoot, 'src/Infra/TypeORM/synthetic-mutation.ts'),
          source,
        },
      ]),
    ).toHaveLength(1)
  })

  it('detects a synthetic runtime bin offender', () => {
    expect(
      findForbiddenCalls([
        {
          path: resolve(packageRoot, 'bin/synthetic-worker.ts'),
          source: "dataSource['transaction'](async () => undefined)",
        },
      ])[0],
    ).toMatch(/^bin[\\/]synthetic-worker\.ts:1:1:transaction$/)
  })
})
