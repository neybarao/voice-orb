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
