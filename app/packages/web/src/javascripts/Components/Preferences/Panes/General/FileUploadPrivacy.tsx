import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import Switch from '@/Components/Switch/Switch'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import {
  getStripImageMetadataEnabled,
  setStripImageMetadataEnabled,
  subscribeStripImageMetadata,
} from '@/Utils/StripImageMetadataSetting'

/**
 * Standard Red Notes: privacy toggle controlling whether EXIF/GPS/metadata is
 * stripped from images before they are uploaded. Stored per-device in
 * localStorage and defaults ON.
 */
const FileUploadPrivacy: FunctionComponent = () => {
  const [enabled, setEnabled] = useState<boolean>(() => getStripImageMetadataEnabled())

  useEffect(() => {
    return subscribeStripImageMetadata(() => {
      setEnabled(getStripImageMetadataEnabled())
    })
  }, [])

  const toggle = useCallback(() => {
    const next = !getStripImageMetadataEnabled()
    setStripImageMetadataEnabled(next)
    setEnabled(next)
  }, [])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>File upload privacy</Title>
        <div className="flex justify-between gap-2 md:items-center">
          <div className="flex flex-col">
            <Subtitle>Strip image metadata on upload</Subtitle>
            <Text>
              Removes EXIF/GPS and other embedded metadata (camera details, location, timestamps) from images before
              they are encrypted and uploaded. JPEG and PNG are stripped losslessly; other formats are re-encoded,
              which may reduce quality or change the file format. Turn off to upload original images unchanged.
            </Text>
          </div>
          <Switch onChange={toggle} checked={enabled} />
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(FileUploadPrivacy)
