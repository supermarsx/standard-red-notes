import { PredicateCompoundOperator, PredicateJsonForm, PredicateOperator } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import Button from '../Button/Button'
import Icon from '../Icon/Icon'
import { CompoundPredicateBuilderController } from './CompoundPredicateBuilderController'
import { PredicateKeypath, PredicateKeypathTypes } from './PredicateKeypaths'
import PredicateValue from './PredicateValue'
import {
  booleanStatementLabel,
  booleanValueIsTrue,
  dateModeFromPredicate,
  DateMode,
  friendlyOperatorsForType,
  getFieldDescription,
  getFieldGroups,
  isRelativeDateValue,
  predicatePartsForDateMode,
  RelativeDateOptions,
  DEFAULT_RELATIVE_DATE_VALUE,
} from './friendlyPredicate'

type Props = {
  controller: CompoundPredicateBuilderController
}

const selectClasses =
  'rounded border border-border bg-default px-2 py-1.5 focus:outline focus:outline-1 focus:outline-info'

const FieldSelect = ({
  value,
  onChange,
}: {
  value: PredicateKeypath
  onChange: (keypath: PredicateKeypath) => void
}) => (
  <select
    className={`flex-grow ${selectClasses}`}
    aria-label="Field"
    value={value}
    onChange={(event) => {
      onChange(event.target.value as PredicateKeypath)
    }}
  >
    {getFieldGroups().map((group) => (
      <optgroup key={group.label} label={group.label}>
        {group.fields.map((field) => (
          <option key={field.keypath} value={field.keypath}>
            {field.label}
          </option>
        ))}
      </optgroup>
    ))}
  </select>
)

/** Yes/No segmented control for boolean fields, e.g. "Is pinned  [Yes|No]". */
const BooleanStatement = ({
  keypath,
  value,
  onChange,
}: {
  keypath: PredicateKeypath
  value: boolean
  onChange: (next: boolean) => void
}) => (
  <div className="flex flex-grow items-center gap-2.5">
    <span className="text-sm font-medium">{booleanStatementLabel(keypath)}</span>
    <div className="border-border inline-flex overflow-hidden rounded border" role="group" aria-label="Yes or no">
      {[
        { label: 'Yes', on: true },
        { label: 'No', on: false },
      ].map((option) => {
        const selected = value === option.on
        return (
          <button
            key={option.label}
            type="button"
            aria-pressed={selected}
            className={`px-3 py-1 text-sm focus:outline-none ${
              selected ? 'bg-info text-info-contrast' : 'bg-default hover:bg-contrast'
            }`}
            onClick={() => {
              onChange(option.on)
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  </div>
)

const DateCondition = ({
  operator,
  value,
  onChange,
}: {
  operator: PredicateOperator
  value: PredicateJsonForm['value']
  onChange: (parts: { operator: PredicateOperator; value: string }) => void
}) => {
  const mode = dateModeFromPredicate(operator, value)
  const stringValue = typeof value === 'string' ? value : ''

  return (
    <div className="flex flex-grow flex-col gap-2 md:flex-row md:items-center">
      <select
        className={selectClasses}
        aria-label="Date comparison"
        value={mode}
        onChange={(event) => {
          onChange(predicatePartsForDateMode(event.target.value as DateMode))
        }}
      >
        <option value="inLast">in the last…</option>
        <option value="after">is after</option>
        <option value="before">is before</option>
      </select>

      {mode === 'inLast' ? (
        <select
          className={`flex-grow ${selectClasses}`}
          aria-label="Relative time range"
          value={isRelativeDateValue(value) ? stringValue : DEFAULT_RELATIVE_DATE_VALUE}
          onChange={(event) => {
            onChange({ operator: '>', value: event.target.value })
          }}
        >
          {RelativeDateOptions.map((option) => (
            <option key={option.id} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="date"
          className={`flex-grow ${selectClasses}`}
          aria-label="Date"
          value={isRelativeDateValue(value) ? '' : stringValue}
          onChange={(event) => {
            onChange({ operator: mode === 'before' ? '<' : '>', value: event.target.value })
          }}
        />
      )}
    </div>
  )
}

const CompoundPredicateBuilder = ({ controller }: Props) => {
  const { operator, setOperator, predicates, setPredicate, changePredicateKeypath, addPredicate, removePredicate } =
    controller

  return (
    <>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="predicate"
            value="and"
            checked={operator === 'and'}
            onChange={(event) => {
              setOperator(event.target.value as PredicateCompoundOperator)
            }}
          />
          Match <span className="font-semibold">all</span> of the conditions below
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="predicate"
            value="or"
            checked={operator === 'or'}
            onChange={(event) => {
              setOperator(event.target.value as PredicateCompoundOperator)
            }}
          />
          Match <span className="font-semibold">any</span> of the conditions below
        </label>
      </div>

      {predicates.map((predicate, index) => {
        const keypath = predicate.keypath as PredicateKeypath
        const type = PredicateKeypathTypes[keypath]

        return (
          <div className="flex flex-col gap-1" key={index}>
            <div className="flex w-full flex-col gap-2 md:flex-row md:items-center">
              {index !== 0 && (
                <div className="text-passive-1 mr-2 text-sm font-semibold">{operator === 'and' ? 'AND' : 'OR'}</div>
              )}

              <FieldSelect
                value={keypath}
                onChange={(newKeypath) => {
                  changePredicateKeypath(index, newKeypath)
                }}
              />

              {type === 'boolean' ? (
                <BooleanStatement
                  keypath={keypath}
                  value={booleanValueIsTrue(predicate.value)}
                  onChange={(next) => {
                    setPredicate(index, { operator: '=', value: next })
                  }}
                />
              ) : type === 'date' ? (
                <DateCondition
                  operator={predicate.operator}
                  value={predicate.value}
                  onChange={(parts) => {
                    setPredicate(index, parts)
                  }}
                />
              ) : (
                <>
                  <select
                    className={selectClasses}
                    aria-label="Condition"
                    value={predicate.operator}
                    onChange={(event) => {
                      setPredicate(index, { operator: event.target.value as PredicateOperator })
                    }}
                  >
                    {friendlyOperatorsForType(type).map((friendly) => (
                      <option key={friendly.operator} value={friendly.operator} title={friendly.hint}>
                        {friendly.label}
                      </option>
                    ))}
                  </select>
                  <PredicateValue
                    keypath={keypath}
                    value={typeof predicate.value !== 'string' ? JSON.stringify(predicate.value) : predicate.value}
                    setValue={(value: string) => {
                      setPredicate(index, { value })
                    }}
                  />
                </>
              )}

              {index !== 0 && (
                <button
                  className="border-border text-danger rounded border p-1"
                  aria-label="Remove condition"
                  onClick={() => {
                    removePredicate(index)
                  }}
                >
                  <Icon type="trash" />
                </button>
              )}
            </div>

            {type !== undefined && <div className="text-passive-1 text-xs">{getFieldDescription(keypath)}</div>}

            {index === predicates.length - 1 && (
              <Button
                className="mt-1 flex items-center gap-2"
                onClick={() => {
                  addPredicate()
                }}
              >
                Add another condition
              </Button>
            )}
          </div>
        )
      })}
    </>
  )
}

export default observer(CompoundPredicateBuilder)
