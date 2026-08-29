import React from "react";
import { Group } from "@mantine/core";
import s from "./Header.module.css";
import type { Data } from "../scripts/types";
import { buildMenuTree, findNodePath } from "../Navigation/menuTree";

interface HeaderProps {
  data: Data;
  currentFormIndex: number;
  setCurrentFormIndex: React.Dispatch<React.SetStateAction<number>>;
}

export default function Header({
  data,
  currentFormIndex,
  setCurrentFormIndex,
}: HeaderProps) {
  const tree = React.useMemo(() => buildMenuTree(data), [data]);
  const activePath = React.useMemo(() => {
    if (currentFormIndex < 0) {
      return [];
    }
    const rootPath = findNodePath(tree.roots, currentFormIndex);
    return rootPath.length > 0
      ? rootPath
      : findNodePath(tree.orphans, currentFormIndex);
  }, [currentFormIndex, tree.orphans, tree.roots]);
  if (currentFormIndex < 0 || activePath.length === 0) {
    return null;
  }

  const currentNode = activePath[activePath.length - 1];
  const profile = tree.profiles.find(
    (candidate) => candidate.id === currentNode.profileId,
  );

  function navigate(formIndex: number | null) {
    if (formIndex === null) {
      return;
    }
    setCurrentFormIndex(formIndex);
    document.getElementById(`nav-${String(formIndex)}`)?.scrollIntoView();
  }

  return (
    <div className={s.root}>
      <Group gap="xs">
        {profile && (
          <>
            <div>{profile.label}</div>
            <div>{">"}</div>
          </>
        )}
        {activePath.map((node, index) => {
          const last = index === activePath.length - 1;
          return (
            <React.Fragment key={node.key}>
              <div
                className={last ? undefined : s.pointer}
                onClick={() => {
                  if (!last) {
                    navigate(node.formIndex);
                  }
                }}
              >
                {node.label}
              </div>
              {!last && <div>{">"}</div>}
            </React.Fragment>
          );
        })}
      </Group>
    </div>
  );
}
