// ═══════════════════════════════════════════
//  Licon — Lottie micro-interaction icons
//  Animations: useAnimations (MIT). Rendered via lottie-web (SVG).
//  Colors are forced to currentColor in CSS so theme/night mode just work.
// ═══════════════════════════════════════════
const Licon = (() => {
  const cache = new Map();   // name → Promise<animationData|null>

  function load(name){
    if(!cache.has(name)){
      cache.set(name,
        fetch(`lottie/${name}.json`).then(r => r.ok ? r.json() : null).catch(() => null));
    }
    return cache.get(name);
  }

  // Mount an icon into `el`. Returns the lottie anim instance (or null on failure).
  // opts: { loop, autoplay, speed }
  async function mount(el, name, opts = {}){
    if(typeof lottie === 'undefined' || !el) return null;
    const data = await load(name);
    if(!data) return null;
    el.classList.add('licon');
    el.innerHTML = '';
    let anim;
    try{
      anim = lottie.loadAnimation({
        container: el,
        renderer: 'svg',
        loop: !!opts.loop,
        autoplay: !!opts.autoplay,
        // deep-clone so each mount owns its data (lottie mutates it)
        animationData: JSON.parse(JSON.stringify(data)),
        rendererSettings: { progressiveLoad: false },
      });
    }catch(e){ return null; }
    if(opts.speed) anim.setSpeed(opts.speed);
    return anim;
  }

  // Two-state toggle (play↔pause, search↔x …). on=true plays forward, false reverses.
  function setState(anim, on){
    if(!anim) return;
    anim.setDirection(on ? 1 : -1);
    anim.play();
  }

  // One-shot nudge from the first frame (skip, bookmark pop, gear settle …).
  function nudge(anim){
    if(!anim) return;
    anim.setDirection(1);
    anim.goToAndPlay(0, true);
  }

  return { mount, setState, nudge, load };
})();
