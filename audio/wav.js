export function pcm16Wave(pcm, sampleRate = 16000) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error('Invalid mono PCM audio.');
  const output = Buffer.alloc(44 + pcm.length);
  output.write('RIFF', 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(pcm.length, 40);
  pcm.copy(output, 44);
  return output;
}

export function pcmWaveform(pcm, sampleRate = 16000) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length % 2) throw new Error('Invalid waveform PCM.');
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error('Invalid waveform sample rate.');
  const samples = pcm.length / 2, waveform = Buffer.alloc(Math.min(256, Math.max(1, Math.ceil(samples / sampleRate * 10))));
  for (let index = 0; index < waveform.length; index++) {
    const start = Math.floor(index * samples / waveform.length);
    const end = Math.min(samples, Math.max(start + 1, Math.floor((index + 1) * samples / waveform.length)));
    let energy = 0;
    for (let sample = start; sample < end; sample++) energy += pcm.readInt16LE(sample * 2) ** 2;
    waveform[index] = Math.min(255, Math.round(Math.sqrt(energy / (end - start)) / 32768 * 255));
  }
  return waveform;
}
