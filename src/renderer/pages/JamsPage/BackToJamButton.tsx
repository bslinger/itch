import React from "react";
import Button from "renderer/basics/Button";

interface Props {
  onClick: () => void;
}

export default function BackToJamButton({ onClick }: Props) {
  return (
    <div style={{ flex: "0 0 auto", padding: "8px 16px" }}>
      <Button icon="arrow-left" onClick={onClick}>
        Back to Jam
      </Button>
    </div>
  );
}
