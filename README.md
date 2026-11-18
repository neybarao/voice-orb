# voice-orb

## Rodar localmente (para exportar antes de publicar)

- Duplo clique em `serve.command` (na primeira vez: botão direito > Abrir, por causa do aviso do macOS).
- Ou no Terminal, dentro da pasta: `node serve.mjs`
- Abre em http://localhost:8765. Para parar, feche a janela do Terminal ou use Ctrl+C.

## States and audio

| State | Shape | Reacts to |
|---|---|---|
| `idle` | sphere | the user's microphone (calm breathing when the mic is off) |
| `speaking` | sphere | the AI voice (a demo voice when no AI audio is playing) |
| `thinking` | ring | nothing, it moves on its own |
| `error` | ring in black and white | nothing |

Any state eases into any other in 1.4 s, from wherever the orb is, even mid-transition.

```js
voiceOrb.setState('speaking');          // 'idle' | 'speaking' | 'thinking' | 'error'
await voiceOrb.useMicrophone();          // user voice -> Idle
voiceOrb.attachAIVoice(audioEl);         // <audio>/<video> element or a MediaStream (e.g. WebRTC) -> Speaking
voiceOrb.stopMicrophone();
```

## Export code (integrar no app)

O botão **Export code** baixa `voice-orb.js`: um web component `<voice-orb>` com as configurações atuais da página (estilo, tema, estado inicial, sensibilidade, tamanho, velocidade e, se quiser, uma cor de fundo igual à tela do app). Funciona em Ionic (Angular, React ou Vue) e no app nativo via Capacitor.

```js
import './assets/voice-orb.js';   // uma vez, ex.: main.ts
// <voice-orb></voice-orb>         // atributos opcionais sobrescrevem: state, orb, theme, sens, size, speed, background
const orb = document.querySelector('voice-orb');
orb.state = 'thinking';
await orb.useMicrophone();
orb.attachAIVoice(audioEl);       // <audio> ou MediaStream
orb.detachAIVoice(audioEl);
orb.destroy();                    // libera o WebGL quando o orb sair de vez
```

- A lógica do componente fica em `orb-component.template.js`. Os shaders são copiados da página na hora do export, então o orb exportado desenha igual à página. Se mudar `advanceMorph`, `liveSpeak` ou o render na página, replique no template.
- O export precisa da página servida por http (GitHub Pages ou `serve.command`), não por `file://`.
