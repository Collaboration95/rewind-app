export interface ReleasedFilm {
  id: string;
  cycleId: string;
  publishedAt: string;
  downloadUrl: string;
}

export interface ReleasedClip {
  id: string;
  contributionId: string;
  cycleId: string;
  createdAt: string;
  downloadUrl: string;
}

export interface ReleasedArchive {
  films: ReleasedFilm[];
  clips: ReleasedClip[];
}
