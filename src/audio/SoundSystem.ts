/**
 * Lecture de sons.
 *
 * Le jeu n'embarque aucun son : ceux qu'il joue sont ceux de votre
 * installation, lus dans les archives comme les textures et les cartes. Rien
 * n'est copie dans le depot.
 *
 * Un navigateur refuse de jouer avant que le joueur ait touche quelque chose.
 * Le contexte audio n'est donc cree qu'au premier clic ou a la premiere touche,
 * et les sons demandes avant cela sont simplement ignores : mieux vaut un menu
 * muet pendant une seconde qu'un contexte suspendu dont plus rien ne sort.
 */

export interface SoundOptions {
  /** Volume du son, avant le volume general. */
  gain?: number;
  /** Variation de hauteur, en demi-tons : evite l'effet mitraillette. */
  detune?: number;
}

export class SoundSystem {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  /**
   * Sons lus dans les archives, en attente de decodage. Le decodage demande un
   * contexte audio, et le contexte demande un geste du joueur : les deux
   * n'arrivent pas dans un ordre garanti, alors les octets sont gardes et
   * decodes des que le contexte existe.
   */
  private readonly raw = new Map<string, ArrayBuffer>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Map<string, Promise<void>>();
  private volume = 0.6;

  /**
   * Prepare le contexte au premier geste du joueur. Appelable plusieurs fois :
   * seul le premier appel compte.
   */
  unlock(): void {
    if (this.context) {
      void this.context.resume();
      return;
    }
    const Constructor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return;
    try {
      this.context = new Constructor();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.context.destination);
    } catch {
      // Le navigateur refuse encore : on reessaiera au prochain geste.
      this.context = null;
      this.master = null;
      return;
    }
    void this.decodeWaiting();
  }

  get ready(): boolean {
    return this.context !== null;
  }

  /** Contexte et sortie, pour les sons fabriques par le code. */
  get output(): { context: AudioContext; destination: GainNode } | null {
    return this.context && this.master ? { context: this.context, destination: this.master } : null;
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master && this.context) {
      // Une rampe courte : un volume qui change d'un coup claque.
      this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.05);
    }
  }

  /**
   * Charge un son depuis les archives montees. Le decodage passe par le
   * navigateur : les sons du jeu sont du PCM, il les lit sans aide.
   */
  load(name: string, read: (path: string) => Promise<Uint8Array | null>): Promise<void> {
    const existing = this.pending.get(name);
    if (existing) return existing;

    const job = (async () => {
      try {
        const bytes = await read(name);
        if (!bytes) return;
        this.raw.set(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        await this.decodeWaiting();
      } catch {
        // Un son absent ou illisible ne doit pas empecher le menu de s'ouvrir.
      }
    })();

    this.pending.set(name, job);
    return job;
  }

  /**
   * Decode ce qui attend, quand le contexte existe. decodeAudioData
   * s'approprie le tampon qu'on lui donne : il en recoit une copie, pour que
   * les octets restent decodables si le contexte change.
   */
  private async decodeWaiting(): Promise<void> {
    const context = this.context;
    if (!context) return;
    for (const [name, bytes] of [...this.raw]) {
      if (this.buffers.has(name)) continue;
      try {
        this.buffers.set(name, await context.decodeAudioData(bytes.slice(0)));
      } catch {
        this.raw.delete(name);
      }
    }
  }

  /** Joue un son deja charge. Sans lui, rien ne se passe et rien n'echoue. */
  play(name: string, options: SoundOptions = {}): void {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.context || !this.master) return;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    if (options.detune) source.detune.value = options.detune * 100;
    if (options.gain !== undefined && options.gain !== 1) {
      const gain = this.context.createGain();
      gain.gain.value = options.gain;
      source.connect(gain).connect(this.master);
    } else {
      source.connect(this.master);
    }
    source.start();
  }

  /** Ce qui est charge et pret, pour verifier sans rien jouer. */
  describe(): {
    state: string;
    volume: number;
    sounds: { name: string; seconds: number }[];
    waiting: number;
  } {
    return {
      state: this.context?.state ?? 'absent',
      volume: this.volume,
      sounds: [...this.buffers.entries()].map(([name, buffer]) => ({
        name,
        seconds: Math.round(buffer.duration * 1000) / 1000,
      })),
      waiting: this.raw.size - this.buffers.size,
    };
  }

  dispose(): void {
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.buffers.clear();
    this.raw.clear();
    this.pending.clear();
  }
}

/** Systeme partage : un seul contexte audio par session. */
export const sound = new SoundSystem();
