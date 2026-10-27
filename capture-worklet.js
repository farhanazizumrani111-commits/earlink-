// Runs on the audio thread. Takes the mic at whatever rate the phone uses
// (usually 48 kHz), downsamples to 16 kHz mono 16-bit PCM, and posts
// 100 ms chunks (1600 samples) back to the page.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate; // sampleRate is a global here
    this.pos = 0;
    this.acc = 0;
    this.cnt = 0;
    this.chunk = 1600; // 100 ms at 16 kHz
    this.buf = new Int16Array(this.chunk);
    this.n = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.cnt++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let v = this.acc / this.cnt; // simple box filter while decimating
        this.acc = 0;
        this.cnt = 0;
        if (v > 1) v = 1; else if (v < -1) v = -1;
        this.sumSq += v * v;
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.chunk) {
          const rms = Math.sqrt(this.sumSq / this.chunk);
          this.port.postMessage({ pcm: this.buf.buffer, rms }, [this.buf.buffer]);
          this.buf = new Int16Array(this.chunk);
          this.n = 0;
          this.sumSq = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
