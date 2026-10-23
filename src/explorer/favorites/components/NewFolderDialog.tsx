import React, { useId, useMemo, useState } from 'react';
import { SelectableValue } from '@grafana/data';
import { Button, Field, Input, Modal, RadioButtonList, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { MAX_TREE_DEPTH, MAX_TREE_NODES } from '../limits';
import { childrenOf, countMenuNodes, folderChoices, nameTaken, type MenuNode } from '../menuModel';
import { ROOT, type NodeRef } from '../types';
import { nameProblem, normalizeName } from '../validation';

/**
 * New folder, from Manage favorites or Save to favorites: names the folder and puts it at the top
 * level or inside the folder selected in the menu. With no folder selected, the top level is the
 * only place.
 */
export const NewFolderDialog: React.FC<{
  nodes: MenuNode[];
  selectedFolder: MenuNode | null;
  onCreate: (name: string, parentRef: NodeRef) => void;
  onDismiss: () => void;
}> = ({ nodes, selectedFolder, onCreate, onDismiss }) => {
  const styles = useStyles2(getStyles);
  const id = useId();

  // A folder nested as deep as allowed cannot hold another one.
  const selectedDepth = selectedFolder ? (childrenOf(nodes, selectedFolder.ref)?.depth ?? MAX_TREE_DEPTH) : 0;
  const insideTooDeep = selectedDepth + 1 > MAX_TREE_DEPTH;

  const [name, setName] = useState('');
  const [parentRef, setParentRef] = useState<NodeRef>(selectedFolder && !insideTooDeep ? selectedFolder.ref : ROOT);
  const [problem, setProblem] = useState('');

  const options = useMemo<Array<SelectableValue<NodeRef>>>(() => {
    const topLevel = { value: ROOT, label: 'Top level' };
    if (!selectedFolder) {
      return [topLevel];
    }
    const path = folderChoices(nodes).find((choice) => choice.ref === selectedFolder.ref)?.label ?? selectedFolder.name;
    return [{ value: selectedFolder.ref, label: `Inside “${path}”` }, topLevel];
  }, [nodes, selectedFolder]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = normalizeName(name);
    const parent = childrenOf(nodes, parentRef);
    const why =
      nameProblem(normalized) ??
      (!parent
        ? 'That folder no longer exists.'
        : nameTaken(parent.siblings, normalized)
          ? `“${normalized}” already exists in this folder.`
          : countMenuNodes(nodes) >= MAX_TREE_NODES
            ? `Favorites hold at most ${MAX_TREE_NODES} entries.`
            : null);
    if (why) {
      setProblem(why);
      return;
    }
    onCreate(normalized, parentRef);
  };

  return (
    <Modal title="New folder" isOpen onDismiss={onDismiss} className={styles.modal}>
      <form onSubmit={submit}>
        <Field label="Folder name" invalid={!!problem} error={problem} htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setProblem('');
            }}
          />
        </Field>
        <Field
          label="Location"
          description={
            !selectedFolder
              ? 'Select a folder in the menu first to create the new folder inside it.'
              : insideTooDeep
                ? `“${selectedFolder.name}” is nested ${MAX_TREE_DEPTH} levels deep, as deep as folders go.`
                : undefined
          }
        >
          <RadioButtonList<NodeRef>
            name={`${id}-location`}
            options={options}
            value={parentRef}
            disabledOptions={insideTooDeep && selectedFolder ? [selectedFolder.ref] : undefined}
            onChange={(value) => {
              setParentRef(value);
              setProblem('');
            }}
          />
        </Field>
        <Modal.ButtonRow>
          <Button variant="secondary" fill="outline" onClick={onDismiss}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="folder-plus" disabled={!normalizeName(name)}>
            Create
          </Button>
        </Modal.ButtonRow>
      </form>
    </Modal>
  );
};

const getStyles = () => ({
  modal: css({
    width: 'min(480px, calc(100vw - 32px))',
  }),
});
