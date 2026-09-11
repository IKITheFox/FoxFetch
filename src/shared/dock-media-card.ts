/** Shared in-page resource card; site controllers retain acquisition ownership. */
export function createDockMediaCard(doc: Document, titleText: string, titleId: string) {
  const card = doc.createElement('article');
  card.className = 'dock-product';
  card.setAttribute('aria-labelledby', titleId);
  const preview = doc.createElement('span');
  preview.className = 'dock-product-preview';
  const body = doc.createElement('div');
  body.className = 'dock-product-copy';
  const title = doc.createElement('strong');
  title.id = titleId;
  title.title = title.textContent = titleText;
  const titleRow = doc.createElement('span');
  titleRow.className = 'dock-product-title-row';
  const fidelityDot = doc.createElement('span');
  fidelityDot.className = 'dock-product-fidelity-dot';
  fidelityDot.dataset.role = 'product-fidelity';
  fidelityDot.setAttribute('role', 'status');
  titleRow.append(title, fidelityDot);
  body.append(titleRow);
  const actions = doc.createElement('div');
  actions.className = 'dock-product-actions';
  card.append(preview, body, actions);
  return { card, preview, body, titleRow, fidelityDot, actions };
}
