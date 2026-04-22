import { Background, ReactFlow, type Edge, type Node } from "@xyflow/react";
import { useMemo } from "react";

import type { KnowledgeNetworkResponse } from "../../types";

type TagNetworkProps = {
  network: KnowledgeNetworkResponse;
  selectedTags: string[];
  expanded: boolean;
  onToggleExpanded(): void;
  onToggleTag(tag: string): void;
  onSelectVideo(videoId: string): void;
};

function truncateLabel(label: string, max = 12) {
  return label.length > max ? `${label.slice(0, max)}…` : label;
}

function getTagTone(count = 0) {
  if (count >= 3) {
    return "is-strong";
  }
  if (count >= 2) {
    return "is-medium";
  }
  return "is-soft";
}

function polarPosition(centerX: number, centerY: number, radiusX: number, radiusY: number, angle: number) {
  return {
    x: centerX + Math.cos(angle) * radiusX,
    y: centerY + Math.sin(angle) * radiusY,
  };
}

export function TagNetwork({
  network,
  selectedTags,
  expanded,
  onToggleExpanded,
  onToggleTag,
  onSelectVideo,
}: TagNetworkProps) {
  const { nodes, edges } = useMemo(() => {
    const selected = new Set(selectedTags);
    const tagNodes = network.nodes
      .filter((node) => node.type === "tag")
      .sort((a, b) => {
        const focusDelta = Number(Boolean(b.focus || selected.has(b.label))) - Number(Boolean(a.focus || selected.has(a.label)));
        if (focusDelta) {
          return focusDelta;
        }
        return Number(b.count || b.degree || 0) - Number(a.count || a.degree || 0);
      });
    const videoNodes = network.nodes.filter((node) => node.type === "video");
    const primaryTags = tagNodes.filter((item) => item.focus || selected.has(item.label));
    const centerTags = primaryTags.length ? primaryTags : tagNodes.slice(0, 1);
    const centerTagIds = new Set(centerTags.map((item) => item.id));
    const ringTags = tagNodes.filter((item) => !centerTagIds.has(item.id));
    const centerX = 560;
    const centerY = 300;

    const flowNodes: Node[] = tagNodes.map((node, index) => {
      const isPrimary = Boolean(node.focus || selected.has(node.label));
      const count = Number(node.count || node.degree || 0);
      const centerIndex = centerTags.findIndex((item) => item.id === node.id);
      const ringIndex = ringTags.findIndex((item) => item.id === node.id);
      const position = centerIndex >= 0
        ? centerTags.length === 1
          ? { x: centerX - 112, y: centerY - 25 }
          : polarPosition(centerX - 110, centerY - 24, 64, 44, (-Math.PI / 2) + (2 * Math.PI * centerIndex) / centerTags.length)
        : polarPosition(
            centerX - 96,
            centerY - 20,
            selected.size ? 320 : 360,
            selected.size ? 190 : 220,
            (-Math.PI / 2) + (2 * Math.PI * Math.max(0, ringIndex)) / Math.max(1, ringTags.length),
          );
      return {
        id: node.id,
        data: { label: `${truncateLabel(node.label)}${node.count ? ` · ${node.count}` : ""}` },
        position,
        className: `knowledge-flow-node is-tag ${getTagTone(count)} ${centerIndex >= 0 ? "is-center" : ""} ${selected.has(node.label) ? "is-active" : ""} ${node.focus ? "is-focus" : ""}`,
        type: "default",
        style: { width: centerIndex >= 0 ? 224 : isPrimary || count >= 3 ? 204 : 184 },
      };
    });

    const videoCardWidth = 216;
    flowNodes.push(
      ...videoNodes.map((node, index) => {
        const angle = (-Math.PI / 2) + (2 * Math.PI * index) / Math.max(1, videoNodes.length);
        return {
          id: node.id,
          data: { label: truncateLabel(node.label, 18) },
          position: polarPosition(centerX - 104, centerY - 22, selected.size ? 500 : 470, selected.size ? 270 : 250, angle),
          className: "knowledge-flow-node is-video",
          type: "default",
          style: { width: videoCardWidth },
        };
      }),
    );

    const flowEdges: Edge[] = network.links.map((link) => ({
      id: `${link.source}-${link.target}`,
      source: link.source,
      target: link.target,
      animated: false,
      className: `knowledge-flow-edge is-${link.kind || "cooccurrence"}`,
      style: {
        strokeWidth: link.kind === "association" ? 1 : Math.min(3, 1 + Number(link.weight || 1) * 0.28),
        opacity: link.kind === "association" ? 0.22 : Math.min(0.48, 0.18 + Number(link.weight || 1) * 0.06),
      },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [network, selectedTags]);

  const tagNodeCount = network.nodes.filter((node) => node.type === "tag").length;
  const videoNodeCount = network.nodes.filter((node) => node.type === "video").length;

  return (
    <div className="knowledge-network-card">
      <div className="knowledge-section-head">
        <div>
          <h3>标签关系概览</h3>
          <p>
            {selectedTags.length
              ? "聚焦已选标签与相关视频。再点一次标签即可取消。"
              : "默认只显示高价值标签与共现关系，避免全量图谱噪音。"}
          </p>
        </div>
        <div className="knowledge-section-actions">
          <div className="knowledge-network-legend" aria-label="图谱统计">
            <span><i className="is-tag" />标签 {tagNodeCount}</span>
            <span><i className="is-video" />视频 {videoNodeCount}</span>
            <span><i className="is-edge" />关系 {network.links.length}</span>
          </div>
          {selectedTags.length ? (
            <button className="tertiary-button" type="button" onClick={() => selectedTags.forEach((tag) => onToggleTag(tag))}>
              清空聚焦
            </button>
          ) : null}
          {network.hidden_tag_count ? (
            <button className="tertiary-button" type="button" onClick={onToggleExpanded}>
              {expanded ? "收起长尾标签" : `查看更多标签 · ${network.hidden_tag_count}`}
            </button>
          ) : null}
        </div>
      </div>
      <div className="knowledge-network-canvas">
        <ReactFlow
          fitView
          fitViewOptions={{ padding: 0.14, maxZoom: 1.02 }}
          nodes={nodes}
          edges={edges}
          onNodeClick={(_event, node) => {
            if (String(node.id).startsWith("tag_")) {
              onToggleTag(String(node.id).replace(/^tag_/, ""));
              return;
            }
            if (String(node.id).startsWith("video_")) {
              onSelectVideo(String(node.id).replace(/^video_/, ""));
            }
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          zoomOnScroll={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={26} size={0.8} />
        </ReactFlow>
      </div>
    </div>
  );
}
