// Diagram boxes with details: clicking one shows its text in that figure's detail panel.
document.addEventListener('click', e => {
  const box = e.target.closest('.visual [data-detail]');
  if (!box) return;
  const fig = box.closest('.visual');
  fig.querySelectorAll('[data-detail].on').forEach(b => {
    b.classList.remove('on');
    b.setAttribute('aria-pressed', 'false');
  });
  box.classList.add('on');
  box.setAttribute('aria-pressed', 'true');
  const panel = fig.querySelector('.detail');
  panel.innerHTML = `<strong></strong> `;
  panel.firstChild.textContent = box.querySelector('.label').textContent + ':';
  panel.append(box.dataset.detail);
});

// On phones the sidebar sits above the page; start it collapsed so content shows first.
if (matchMedia('(max-width:860px)').matches) document.querySelectorAll('.toc').forEach(d => { d.open = false; });
