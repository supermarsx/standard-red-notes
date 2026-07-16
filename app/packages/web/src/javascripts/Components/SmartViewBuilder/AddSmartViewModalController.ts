import { WebApplication } from '@/Application/WebApplication'
import { CompoundPredicateBuilderController } from '@/Components/SmartViewBuilder/CompoundPredicateBuilderController'
import {
  DecryptedItemInterface,
  ItemContent,
  predicateFromJson,
  PredicateJsonForm,
  SmartViewDefaultIconName,
  SNTag,
  VectorIconNameOrEmoji,
} from '@standardnotes/snjs'
import { action, computed, makeObservable, observable } from 'mobx'
import { PredicatePreset, presetToJsonString, validatePredicateJsonString } from './PredicateGuidance'

export class AddSmartViewModalController {
  isAddingSmartView = false
  isSaving = false

  title = ''

  icon: VectorIconNameOrEmoji = SmartViewDefaultIconName

  predicateController = new CompoundPredicateBuilderController()

  customPredicateJson: string | undefined = undefined
  isCustomJsonValidPredicate: boolean | undefined = undefined

  constructor(private application: WebApplication) {
    makeObservable(this, {
      isAddingSmartView: observable,
      setIsAddingSmartView: action,

      isSaving: observable,
      setIsSaving: action,

      title: observable,
      setTitle: action,

      icon: observable,
      setIcon: action,

      customPredicateJson: observable,
      isCustomJsonValidPredicate: observable,
      setCustomPredicateJson: action,
      setIsCustomJsonValidPredicate: action,
      insertPreset: action,
      applyTemplate: action,

      customPredicateValidationError: computed,
    })
  }

  /**
   * Apply a quick-start template into the guided builder: loads its predicate
   * into the builder rows and, when the user hasn't named the view yet,
   * suggests a title. Only builder-compatible presets should be passed.
   */
  applyTemplate = (preset: PredicatePreset) => {
    this.predicateController.loadFromJson(preset.predicate)
    if (!this.title.trim()) {
      this.setTitle(preset.title ?? preset.label)
    }
  }

  /**
   * The current in-memory notes and files, used to compute the live match
   * preview. Reading through the item manager keeps the modal decoupled from
   * how items are stored.
   */
  getPreviewItems = (): DecryptedItemInterface[] => this.application.items.getDisplayableNotesAndFiles()

  getTagsForItem = (item: DecryptedItemInterface): SNTag[] =>
    this.application.items.getSortedTagsForItem(item as DecryptedItemInterface<ItemContent>)

  /**
   * Live validation of the custom JSON the user is typing. Returns the
   * human-readable error (or undefined when valid/empty) so the UI can show
   * inline feedback without the user having to click "Validate".
   */
  get customPredicateValidationError(): string | undefined {
    if (this.customPredicateJson === undefined || this.customPredicateJson.length === 0) {
      return undefined
    }
    return validatePredicateJsonString(this.customPredicateJson).error
  }

  setIsAddingSmartView = (isAddingSmartView: boolean) => {
    this.isAddingSmartView = isAddingSmartView
  }

  setIsSaving = (isSaving: boolean) => {
    this.isSaving = isSaving
  }

  setTitle = (title: string) => {
    this.title = title
  }

  setIcon = (icon: VectorIconNameOrEmoji) => {
    this.icon = icon
  }

  setCustomPredicateJson = (customPredicateJson: string) => {
    this.customPredicateJson = customPredicateJson
    if (customPredicateJson.length === 0) {
      this.isCustomJsonValidPredicate = undefined
    } else {
      this.isCustomJsonValidPredicate = validatePredicateJsonString(customPredicateJson).isValid
    }
  }

  setIsCustomJsonValidPredicate = (isCustomJsonValidPredicate: boolean | undefined) => {
    this.isCustomJsonValidPredicate = isCustomJsonValidPredicate
  }

  /**
   * Insert a preset predicate into the custom JSON field, pretty-printed and
   * marked valid so the user can immediately save or tweak it.
   */
  insertPreset = (preset: PredicatePreset) => {
    this.customPredicateJson = presetToJsonString(preset)
    this.isCustomJsonValidPredicate = true
  }

  closeModal = () => {
    this.setIsAddingSmartView(false)
    this.setTitle('')
    this.setIcon('')
    this.setIsSaving(false)
    this.predicateController.resetState()
    this.setCustomPredicateJson('')
    this.setIsCustomJsonValidPredicate(undefined)
  }

  saveCurrentSmartView = async () => {
    this.setIsSaving(true)

    if (!this.title) {
      this.setIsSaving(false)
      return
    }

    const predicateJson =
      this.customPredicateJson && this.isCustomJsonValidPredicate
        ? JSON.parse(this.customPredicateJson)
        : this.predicateController.toJson()
    const predicate = predicateFromJson(predicateJson as PredicateJsonForm)

    await this.application.mutator.createSmartView({
      title: this.title,
      predicate,
      iconString: this.icon as string,
      vault: this.application.vaultDisplayService.exclusivelyShownVault,
    })

    this.setIsSaving(false)
    this.closeModal()
  }

  validateAndPrettifyCustomPredicate = () => {
    if (!this.customPredicateJson) {
      this.setIsCustomJsonValidPredicate(false)
      return
    }

    try {
      const parsedPredicate: PredicateJsonForm = JSON.parse(this.customPredicateJson)
      const predicate = predicateFromJson(parsedPredicate)

      if (predicate) {
        this.setCustomPredicateJson(JSON.stringify(parsedPredicate, null, 2))
        this.setIsCustomJsonValidPredicate(true)
      } else {
        this.setIsCustomJsonValidPredicate(false)
      }
    } catch {
      this.setIsCustomJsonValidPredicate(false)
      return
    }
  }
}
