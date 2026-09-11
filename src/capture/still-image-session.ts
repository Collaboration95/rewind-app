import {
  CaptureFileLifecycleError,
  type ActiveStillImage,
  type CameraPlatform,
  type CaptureFileStore,
  type ImageMetadata,
  type ImageMetadataStore,
  type PersistedStillImage,
} from './contracts';

export interface StillImageCaptureSessionOptions {
  platform: CameraPlatform;
  fileStore: CaptureFileStore;
  metadataStore: ImageMetadataStore;
  now?: () => Date;
  createId?: () => string;
}

/**
 * Coordinates temporary files and metadata. A URI lives only in the active
 * session; durable storage receives metadata after the app-managed copy has
 * been verified. Retake, discard, and reset are idempotent cleanup paths.
 */
export class StillImageCaptureSession {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private active: ActiveStillImage | null = null;
  private accepted = false;

  constructor(private readonly options: StillImageCaptureSessionOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId =
      options.createId ?? (() => `capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }

  getActivePreview(): ActiveStillImage | null {
    return this.active ? { ...this.active, metadata: { ...this.active.metadata } } : null;
  }

  async capture(): Promise<ActiveStillImage> {
    await this.cleanupActive();
    const image = await this.options.platform.captureStill();
    const id = this.createId();
    const managed = await this.options.fileStore.copyToManagedCache(image, id);

    try {
      const verified = await this.options.fileStore.exists(managed.uri);
      if (!verified) {
        await this.options.fileStore.remove(managed.uri);
        throw new CaptureFileLifecycleError(
          'The captured image could not be verified in app storage. Try taking it again.',
        );
      }
    } catch (error) {
      await this.options.fileStore.remove(managed.uri).catch(() => undefined);
      if (error instanceof CaptureFileLifecycleError) throw error;
      throw new CaptureFileLifecycleError(
        'The captured image could not be verified in app storage. Try taking it again.',
      );
    }

    const metadata: ImageMetadata = {
      id,
      capturedAt: this.now().toISOString(),
      format: image.format,
      mimeType: image.format === 'jpg' ? 'image/jpeg' : 'image/png',
      width: image.width,
      height: image.height,
      byteLength: managed.byteLength,
      source: image.source,
    };
    this.active = { previewUri: managed.uri, metadata };
    this.accepted = false;
    return this.getActivePreview()!;
  }

  async accept(): Promise<PersistedStillImage> {
    if (!this.active) {
      throw new CaptureFileLifecycleError('Take a still image before accepting the preview.');
    }

    try {
      await this.options.metadataStore.save(this.active.metadata);
      this.accepted = true;
      return { metadata: { ...this.active.metadata } };
    } catch {
      await this.cleanupActive();
      throw new CaptureFileLifecycleError(
        'The image was captured but its local metadata could not be saved. Try again.',
      );
    }
  }

  async retake(): Promise<void> {
    // A saved still is durable. Retaking only releases the transient preview
    // file; it must not remove the accepted metadata record.
    await this.cleanupActive(!this.accepted);
  }

  async discard(): Promise<void> {
    await this.cleanupActive();
  }

  async reset(): Promise<void> {
    await this.cleanupActive();
    await this.options.metadataStore.clear();
  }

  /**
   * Route unmount cleanup removes only the in-flight preview. A route change
   * must not erase accepted metadata; an explicit app/demo reset uses reset().
   */
  async dispose(): Promise<void> {
    // Once accepted, metadata is intentionally retained across route changes;
    // only the transient preview file is released. Unaccepted previews are
    // discarded completely.
    await this.cleanupActive(!this.accepted);
  }

  private async cleanupActive(removeMetadata = true): Promise<void> {
    const active = this.active;
    this.active = null;
    this.accepted = false;
    if (!active) return;

    await this.options.fileStore.remove(active.previewUri).catch(() => undefined);
    if (removeMetadata) {
      await this.options.metadataStore.remove(active.metadata.id).catch(() => undefined);
    }
  }

  isAccepted(): boolean {
    return this.accepted;
  }
}
