// AudioWorklet capture (DESIGN §15.2): hands each 128-sample mono block to the page, which packs
// them into 80 ms PCM frames. Kept as a plain file under /public because a worklet module loads by URL.
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("cs-capture", Capture);
