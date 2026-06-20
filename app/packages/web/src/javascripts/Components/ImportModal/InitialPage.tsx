import { ImportModalController } from '@/Components/ImportModal/ImportModalController'
import { observer } from 'mobx-react-lite'
import Button from '../Button/Button'
import Icon from '../Icon/Icon'
import { useApplication } from '../ApplicationProvider'
import { FeatureName } from '@/Controllers/FeatureName'
import { NativeFeatureIdentifier, FeatureStatus } from '@standardnotes/snjs'
import { c } from 'ttag'

type Props = {
  setFiles: ImportModalController['setFiles']
  selectFiles: (service?: string) => Promise<void>
}

const ImportModalInitialPage = ({ setFiles, selectFiles }: Props) => {
  const application = useApplication()

  return (
    <>
      <button
        onClick={() => selectFiles()}
        className="flex min-h-[30vh] w-full flex-col items-center justify-center gap-2 rounded border-2 border-dashed border-info p-2 hover:border-4"
        onDragStart={(e) => e.preventDefault()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const files = Array.from(e.dataTransfer.files)
          setFiles(files)
        }}
      >
        <div className="text-lg font-semibold">{c('Info').t`Drag and drop files to auto-detect and import`}</div>
        <div className="text-sm">{c('Info').t`Or click to open file picker`}</div>
      </button>
      <div className="my-4 w-full text-center">{c('Info').t`or import from:`}</div>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <Button className="flex items-center !py-2" onClick={() => selectFiles('standard-notes-backup')}>
          <Icon type="archive" className="mr-2 text-info" />
          {c('ImportSource').t`Standard Red Notes Backup`}
        </Button>
        <Button className="flex items-center !py-2" onClick={() => selectFiles('evernote')}>
          <Icon type="evernote" className="mr-2 text-[#14cc45]" />
          Evernote
        </Button>
        <Button className="flex items-center !py-2" onClick={() => selectFiles('google-keep')}>
          <Icon type="gkeep" className="mr-2 text-[#fbbd00]" />
          Google Keep
        </Button>
        <Button
          className="flex items-center !py-2"
          title={c('ImportSource')
            .t`OneNote has no open export format. Export a page as a Web Page (.html) or Markdown (.md) and import that. The proprietary .one file is not supported.`}
          onClick={() => selectFiles('onenote')}
        >
          <Icon type="rich-text" className="mr-2 text-[#7719aa]" />
          OneNote (HTML / Markdown)
        </Button>
        <Button
          className="flex items-center !py-2"
          title={c('ImportSource')
            .t`Zoho Notebook exports a notebook as a .zip of HTML/.zhtml notecards. Unzip it and import the card files.`}
          onClick={() => selectFiles('zoho-notebook')}
        >
          <Icon type="rich-text" className="mr-2 text-[#f9b21d]" />
          Zoho Notebook (HTML / .zhtml)
        </Button>
        <Button className="flex items-center !py-2" onClick={() => selectFiles('simplenote')}>
          <Icon type="simplenote" className="mr-2 text-[#3360cc]" />
          Simplenote
        </Button>
        <Button className="flex items-center !py-2" onClick={() => selectFiles('aegis')}>
          <Icon type="aegis" className="mr-2 rounded bg-[#0d47a1] p-1 text-[#fff]" size="normal" />
          Aegis
        </Button>
        <Button className="flex items-center !py-2" onClick={() => selectFiles('plaintext')}>
          <Icon type="plain-text" className="mr-2 text-info" />
          {c('ImportSource').t`Plaintext / Markdown`}
        </Button>
        <Button className="flex items-center !py-2" onClick={() => selectFiles('html')}>
          <Icon type="rich-text" className="mr-2 text-accessory-tint-2" />
          HTML
        </Button>
        <Button
          className="flex items-center !py-2"
          onClick={() => {
            const isEntitledToSuper =
              application.features.getFeatureStatus(
                NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.SuperEditor).getValue(),
              ) === FeatureStatus.Entitled
            if (!isEntitledToSuper) {
              application.showPremiumModal(FeatureName.Super)
              return
            }
            selectFiles('super').catch(console.error)
          }}
        >
          <Icon type="file-doc" className="mr-2 text-accessory-tint-1" />
          Super (JSON)
        </Button>
        <Button className="flex items-center !py-2" onClick={() => selectFiles('csv-markdown')}>
          <Icon type="toc" className="mr-2 text-info" />
          {c('ImportSource').t`CSV (Markdown table)`}
        </Button>
        <Button
          className="flex items-center !py-2"
          onClick={() => {
            const isEntitledToSuper =
              application.features.getFeatureStatus(
                NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.SuperEditor).getValue(),
              ) === FeatureStatus.Entitled
            if (!isEntitledToSuper) {
              application.showPremiumModal(FeatureName.Super)
              return
            }
            selectFiles('csv-spreadsheet').catch(console.error)
          }}
        >
          <Icon type="spreadsheets" className="mr-2 text-accessory-tint-3" />
          {c('ImportSource').t`CSV (Spreadsheet)`}
        </Button>
      </div>
    </>
  )
}

export default observer(ImportModalInitialPage)
