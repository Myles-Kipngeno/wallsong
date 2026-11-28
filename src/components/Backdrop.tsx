/**
 * Shown when there's no music video on screen: the album art, huge,
 * blurred and slowly drifting. Falls back to a dark gradient.
 */
export function Backdrop({ artwork }: { artwork: string | null }) {
  return (
    <div className="backdrop" aria-hidden="true">
      {artwork && <img key={artwork.length} className="backdrop-art" src={artwork} alt="" />}
      <div className="backdrop-shade" />
    </div>
  );
}
