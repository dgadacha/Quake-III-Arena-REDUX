import type { MoveInput } from './physics';

/**
 * Clavier et souris. Les touches sont lues par position physique, si bien que
 * la rangee ZQSD d'un clavier francais et la rangee WASD d'un clavier anglais
 * donnent les memes commandes.
 */
export class Input {
  private readonly pressed = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private locked = false;
  /** Sensibilite en radians par pixel. */
  sensitivity = 0.0022;
  invertY = false;
  onFire: ((held: boolean) => void) | null = null;
  /** Selection directe : touches 1 a 9. */
  onSelectWeapon: ((index: number) => void) | null = null;
  /** Arme suivante ou precedente, a la molette. */
  onCycleWeapon: ((step: number) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.releaseAll);
    document.addEventListener('pointerlockchange', this.handleLockChange);
    document.addEventListener('mousemove', this.handleMouseMove);
    canvas.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('wheel', this.handleWheel, { passive: true });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.releaseAll);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
    document.removeEventListener('mousemove', this.handleMouseMove);
  }

  get isLocked(): boolean {
    return this.locked;
  }

  requestLock(): void {
    // Certains contextes refusent le verrou : la partie continue sans lui.
    void Promise.resolve(this.canvas.requestPointerLock()).catch(() => undefined);
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  setAngles(yaw: number, pitch = 0): void {
    this.yaw = yaw;
    this.pitch = pitch;
  }

  /** Etat des commandes pour un pas de simulation. */
  sample(): MoveInput {
    const forward = (this.held('KeyW', 'ArrowUp') ? 1 : 0) - (this.held('KeyS', 'ArrowDown') ? 1 : 0);
    const right = (this.held('KeyD', 'ArrowRight') ? 1 : 0) - (this.held('KeyA', 'ArrowLeft') ? 1 : 0);
    const jump = this.held('Space');
    const crouch = this.held('ControlLeft', 'ControlRight', 'KeyC');
    return {
      forward: forward * 127,
      right: right * 127,
      up: jump ? 127 : crouch ? -127 : 0,
      jump,
      crouch,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  get angles(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  private held(...codes: string[]): boolean {
    return codes.some((code) => this.pressed.has(code));
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Space') event.preventDefault();
    this.pressed.add(event.code);

    // Les chiffres du pave principal choisissent une arme.
    const digit = /^Digit([1-9])$/.exec(event.code);
    if (digit) this.onSelectWeapon?.(Number(digit[1]) - 1);
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.locked) return;
    this.onCycleWeapon?.(event.deltaY > 0 ? 1 : -1);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  private releaseAll = (): void => {
    this.pressed.clear();
  };

  private handleLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this.releaseAll();
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.locked) return;
    this.yaw -= event.movementX * this.sensitivity;
    const delta = event.movementY * this.sensitivity * (this.invertY ? -1 : 1);
    this.pitch = clampPitch(this.pitch + delta);
    // Garder l'angle dans un tour evite les pertes de precision a la longue.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.locked) {
      this.requestLock();
      return;
    }
    if (event.button === 0) this.onFire?.(true);
  };

  private handleMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) this.onFire?.(false);
  };
}

/** La vue ne bascule jamais tout a fait a la verticale. */
function clampPitch(pitch: number): number {
  const limit = Math.PI / 2 - 0.01;
  return Math.max(-limit, Math.min(limit, pitch));
}
