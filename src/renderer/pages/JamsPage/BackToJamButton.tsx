import React from "react";
import Button from "renderer/basics/Button";

interface Props {
  onClick: () => void;
  keep?: {
    checked: boolean;
    disabled: boolean;
    onChange: (kept: boolean) => void;
  };
}

export default function BackToJamButton({ onClick, keep }: Props) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        padding: "8px 16px",
        display: "flex",
        alignItems: "center",
        gap: 16,
      }}
    >
      <Button icon="arrow-left" onClick={onClick}>
        Back to Jam
      </Button>
      {keep ? (
        <label>
          <input
            type="checkbox"
            checked={keep.checked}
            disabled={keep.disabled}
            onChange={(event) => keep.onChange(event.target.checked)}
          />{" "}
          Keep installed after jam
        </label>
      ) : null}
    </div>
  );
}
