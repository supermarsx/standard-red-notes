export const shouldShowLinkedItemsToggle = (
  itemCount: number,
  layoutCanCollapseMeaningfully: boolean,
  hideToggle: boolean,
): boolean => !hideToggle && (itemCount > 5 || layoutCanCollapseMeaningfully)
