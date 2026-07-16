import { getDropdownItemsForAllEditors } from '@/Utils/DropdownItemsForEditors'
import { NoteType } from '@standardnotes/snjs'
import { useApplication } from '../ApplicationProvider'
import { PredicateKeypath, PredicateKeypathTypes } from './PredicateKeypaths'

type Props = {
  keypath: PredicateKeypath
  value: string
  setValue: (value: string) => void
}

const PredicateValue = ({ keypath, value, setValue }: Props) => {
  const application = useApplication()
  const type = PredicateKeypathTypes[keypath]
  const editorItems = getDropdownItemsForAllEditors(application)

  return type === 'noteType' ? (
    <select
      className="border-border bg-default focus:outline-info flex-grow rounded border px-2 py-1.5 focus:outline focus:outline-1"
      value={value}
      onChange={(event) => {
        setValue(event.target.value)
      }}
    >
      {Object.entries(NoteType).map(([key, value]) => (
        <option key={key} value={value}>
          {key}
        </option>
      ))}
    </select>
  ) : type === 'editorIdentifier' ? (
    <select
      className="border-border bg-default focus:outline-info flex-grow rounded border px-2 py-1.5 focus:outline focus:outline-1"
      value={value}
      onChange={(event) => {
        setValue(event.target.value)
      }}
    >
      {editorItems.map((editor) => (
        <option key={editor.value} value={editor.value}>
          {editor.label}
        </option>
      ))}
    </select>
  ) : type === 'string' || type === 'date' ? (
    <input
      className="border-border bg-default flex-grow rounded border px-2 py-1.5"
      value={value}
      onChange={(event) => {
        setValue(event.target.value)
      }}
    />
  ) : type === 'boolean' ? (
    <select
      className="border-border bg-default focus:outline-info flex-grow rounded border px-2 py-1.5 focus:outline focus:outline-1"
      value={value}
      onChange={(event) => {
        setValue(event.target.value)
      }}
    >
      <option value="true">True</option>
      <option value="false">False</option>
    </select>
  ) : type === 'number' ? (
    <input
      type="number"
      className="border-border bg-default flex-grow rounded border px-2 py-1.5"
      value={value}
      onChange={(event) => {
        setValue(event.target.value)
      }}
    />
  ) : null
}

export default PredicateValue
