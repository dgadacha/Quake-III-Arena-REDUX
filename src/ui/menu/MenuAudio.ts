import { sound } from '../../audio/SoundSystem';

/**
 * Sons du menu.
 *
 * Ce sont ceux du jeu, lus dans vos archives : le menu d'origine emploie
 * quatre echantillons courts, et chacun a son role. Le deplacement d'une
 * entree a l'autre prend celui du changement de focus, la validation celui de
 * l'entree dans un menu, le retour celui de la sortie, et une entree
 * indisponible repond par le buzz. Une trentaine de kilo-octets en tout, et le
 * menu sonne comme en 1999.
 *
 * S'y ajoute une ambiance, elle fabriquee par le code : deux basses tres
 * graves battant l'une contre l'autre et un souffle filtre, au ras du silence.
 * Le decor du menu est la salle de lave de q3dm7 ; ce grondement est la pour
 * qu'elle ne soit pas muette, pas pour s'entendre.
 */

/** Les quatre sons du menu d'origine, avec l'emploi que le jeu leur donne. */
const SOUNDS = {
  move: 'sound/misc/menu2.wav',
  select: 'sound/misc/menu1.wav',
  back: 'sound/misc/menu3.wav',
  deny: 'sound/misc/menu4.wav',
} as const;

export type MenuSound = keyof typeof SOUNDS;

/** Niveau de l'ambiance : elle doit rester sous le seuil de l'attention. */
const AMBIENCE_GAIN = 0.05;

export class MenuAudio {
  private loaded = false;
  private ambience: { gain: GainNode; stop: () => void } | null = null;

  /**
   * Charge les quatre sons depuis les archives montees. Sans eux, le menu
   * reste muet : aucun son de remplacement n'est fabrique, ce serait un autre
   * jeu.
   */
  async load(read: (path: string) => Promise<Uint8Array | null>): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await Promise.all(Object.values(SOUNDS).map((path) => sound.load(path, read)));
  }

  play(kind: MenuSound): void {
    // Un demi-ton de variation : deux pressions de suite ne sonnent pas
    // exactement pareil, et la repetition ne s'entend plus.
    sound.play(SOUNDS[kind], { detune: (Math.random() - 0.5) * 1.2 });
  }

  /**
   * Fait entrer l'ambiance, ou la reprend si elle est deja la. Le montage est
   * construit une fois et garde : deux oscillateurs desaccordes, un souffle
   * passe au filtre passe-bas, et une enveloppe qui met deux secondes a monter.
   */
  startAmbience(): void {
    const output = sound.output;
    if (!output) return;
    if (this.ambience) {
      this.ambience.gain.gain.setTargetAtTime(AMBIENCE_GAIN, output.context.currentTime, 1.2);
      return;
    }

    const { context, destination } = output;
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(destination);

    // Deux basses proches : leur battement lent evite le bourdonnement fixe.
    const drones: OscillatorNode[] = [];
    for (const frequency of [41.2, 43.65]) {
      const oscillator = context.createOscillator();
      oscillator.type = 'sawtooth';
      oscillator.frequency.value = frequency;
      const shaped = context.createBiquadFilter();
      shaped.type = 'lowpass';
      shaped.frequency.value = 180;
      shaped.Q.value = 0.7;
      const level = context.createGain();
      level.gain.value = 0.5;
      oscillator.connect(shaped).connect(level).connect(gain);
      oscillator.start();
      drones.push(oscillator);
    }

    // Souffle : du bruit blanc en boucle, coupe haut et bas. C'est ce qui
    // donne l'air qui circule dans une salle de pierre.
    const seconds = 4;
    const noise = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
    const data = noise.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < data.length; index++) {
      // Bruit legerement lisse : du blanc pur siffle, celui-ci souffle.
      previous = previous * 0.96 + (Math.random() * 2 - 1) * 0.04;
      data[index] = previous * 6;
    }
    const wind = context.createBufferSource();
    wind.buffer = noise;
    wind.loop = true;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 420;
    band.Q.value = 0.4;
    const windLevel = context.createGain();
    windLevel.gain.value = 0.35;
    wind.connect(band).connect(windLevel).connect(gain);
    wind.start();

    gain.gain.setTargetAtTime(AMBIENCE_GAIN, context.currentTime, 1.2);
    this.ambience = {
      gain,
      stop: () => {
        for (const oscillator of drones) oscillator.stop();
        wind.stop();
      },
    };
  }

  /** Laisse l'ambiance s'eteindre : on entre en partie, elle n'a plus lieu. */
  stopAmbience(): void {
    const output = sound.output;
    if (!this.ambience || !output) return;
    this.ambience.gain.gain.setTargetAtTime(0, output.context.currentTime, 0.4);
  }

  /** Etat des sons du menu : charges, prets, et l'ambiance en cours ou non. */
  describe(): { ambience: boolean } & ReturnType<typeof sound.describe> {
    return { ambience: this.ambience !== null, ...sound.describe() };
  }

  dispose(): void {
    this.ambience?.stop();
    this.ambience = null;
  }
}
