// Runs on the browser's audio thread for lossless capture. It only copies each
// block of samples and hands them to the page: nothing is processed or changed.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data === "stop") this.active = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      // A copy: the browser reuses these arrays for the next block.
      this.port.postMessage(input.map((channel) => channel.slice(0)));
    }
    return this.active;
  }
}

registerProcessor("pcm-capture", PcmCapture);
