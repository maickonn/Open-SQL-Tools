// Motion-graphics layer injected into the app window while the demo is recorded:
// captions, title cards, a drawn cursor and click ripples. Pure DOM, no app code involved.

/** Runs inside the renderer (serialized by Playwright), so it must be self-contained. */
export function installOverlay(iconUrl) {
  if (window.__demo) return
  const css = `
    #demo-layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: 'Inter Variable', system-ui, sans-serif; }
    #demo-caption { position: absolute; left: 50%; bottom: 40px; transform: translate(-50%, 24px); opacity: 0;
      padding: 16px 32px; border-radius: 999px; background: rgba(14, 15, 19, 0.9); color: #fff; font-size: 28px; font-weight: 600;
      letter-spacing: -0.01em; box-shadow: 0 12px 40px rgba(0,0,0,.45), inset 0 0 0 1.5px rgba(91,141,239,.6);
      transition: transform .45s cubic-bezier(.2,.9,.3,1.2), opacity .35s ease; white-space: nowrap; }
    #demo-caption.on { transform: translate(-50%, 0); opacity: 1; }
    #demo-caption b { color: #8fb3ff; font-weight: 700; }
    #demo-cursor { position: absolute; left: 0; top: 0; width: 22px; height: 22px; transform: translate(-100px, -100px);
      transition: transform .55s cubic-bezier(.45,.05,.25,1); filter: drop-shadow(0 2px 3px rgba(0,0,0,.5)); }
    .demo-ripple { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
      border: 3px solid #5b8def; animation: demo-ripple .6s ease-out forwards; }
    @keyframes demo-ripple { from { transform: scale(.4); opacity: 1 } to { transform: scale(3.2); opacity: 0 } }
    #demo-card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
      background: radial-gradient(1200px 700px at 50% 35%, #1d2a4a 0%, #121318 60%, #0c0d10 100%); color: #fff; opacity: 0; transition: opacity .5s ease; }
    #demo-card.on { opacity: 1; }
    #demo-card img { width: 112px; height: 112px; animation: demo-pop .8s cubic-bezier(.2,.9,.3,1.3) both; }
    #demo-card h1 { margin: 0; font-size: 54px; font-weight: 800; letter-spacing: -0.03em; animation: demo-rise .7s .12s ease both; }
    #demo-card p { margin: 0; font-size: 22px; color: #b9c3d8; animation: demo-rise .7s .24s ease both; }
    #demo-card .badges { display: flex; gap: 10px; margin-top: 10px; }
    #demo-card .badges span { padding: 7px 14px; border-radius: 999px; background: rgba(91,141,239,.16); color: #cfdcff;
      font-size: 16px; font-weight: 600; box-shadow: inset 0 0 0 1px rgba(91,141,239,.4); animation: demo-rise .6s ease both; }
    @keyframes demo-pop { from { transform: scale(.6); opacity: 0 } to { transform: scale(1); opacity: 1 } }
    @keyframes demo-rise { from { transform: translateY(18px); opacity: 0 } to { transform: none; opacity: 1 } }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  const layer = document.createElement('div')
  layer.id = 'demo-layer'
  layer.innerHTML = `
    <div id="demo-caption"></div>
    <svg id="demo-cursor" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10.1 13 L16 13 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`
  document.body.append(layer)
  const caption = layer.querySelector('#demo-caption')
  const cursor = layer.querySelector('#demo-cursor')
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  window.__demo = {
    async caption(html) {
      if (caption.classList.contains('on')) {
        caption.classList.remove('on')
        await wait(300)
      }
      caption.innerHTML = html
      caption.classList.add('on')
    },
    hideCaption() {
      caption.classList.remove('on')
    },
    async card(html) {
      layer.querySelector('#demo-card')?.remove()
      const card = document.createElement('div')
      card.id = 'demo-card'
      card.innerHTML = `<img src="${iconUrl}" alt="">${html}`
      card.querySelectorAll('.badges span').forEach((b, i) => (b.style.animationDelay = `${0.35 + i * 0.08}s`))
      layer.prepend(card)
      requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('on')))
      await wait(500)
    },
    async hideCard() {
      const card = layer.querySelector('#demo-card')
      if (!card) return
      card.classList.remove('on')
      await wait(500)
      card.remove()
    },
    moveCursor(x, y, ms = 550) {
      cursor.style.transitionDuration = `${ms}ms`
      cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`
      return wait(ms)
    },
    ripple(x, y) {
      const r = document.createElement('div')
      r.className = 'demo-ripple'
      r.style.left = `${x}px`
      r.style.top = `${y}px`
      layer.append(r)
      setTimeout(() => r.remove(), 700)
    }
  }
}
