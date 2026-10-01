"""Inference-only DBNet++ for the official COO fine-tuned checkpoint.

Architecture reference: MhLiao/DB, commit 65ca77a0bcfbd7114b916cf8a1e9ca85114286ce.
Uses torchvision's maintained deformable convolution instead of the legacy CUDA
extension. The checkpoint's training-only threshold head is intentionally unused.
"""
from pathlib import Path
import hashlib
import torch
from torch.nn import functional as F
from torchvision.ops import deform_conv2d

CHECKPOINT_SHA256 = '889a26c041cc03be7c3864de940368dc393b46d036da49f9bf762a8b798724cf'


def legacy_offsets(offset, mask, height, width):
    """Match upstream DCNv2's contiguous reads at stride-two stage entries.

    Its offset predictor has stride one, but the CUDA kernel indexes the first
    C*Hout*Wout elements as a compact output grid (not a spatial subsample).
    Keeping that layout is essential for this already-trained checkpoint.
    """
    n = offset.shape[0]
    return (offset.reshape(n, -1)[:, :18*height*width].reshape(n,18,height,width).contiguous(),
            mask.reshape(n, -1)[:, :9*height*width].reshape(n,9,height,width).contiguous())


class COOModel:
    def __init__(self, path: Path, device='cpu'):
        if hashlib.sha256(path.read_bytes()).hexdigest() != CHECKPOINT_SHA256:
            raise ValueError('COO checkpoint checksum mismatch; run scripts/install-coo.py')
        states = torch.load(path, map_location='cpu', weights_only=True)
        self.s = {k.removeprefix('model.module.'): v.to(device) for k,v in states.items()}
        self.device = device

    def conv(self, x, name, stride=1, padding=0):
        return F.conv2d(x,self.s[name+'.weight'],self.s.get(name+'.bias'),stride,padding)

    def bn(self, x, name):
        return F.batch_norm(x,self.s[name+'.running_mean'],self.s[name+'.running_var'],
                            self.s[name+'.weight'],self.s[name+'.bias'],training=False,eps=1e-5)

    def block(self, x, name, stride, deform):
        skip = x
        y = F.relu(self.bn(self.conv(x,name+'.conv1'),name+'.bn1'))
        if deform:
            om = self.conv(y,name+'.conv2_offset',padding=1)
            h,w = (y.shape[2]+1)//stride,(y.shape[3]+1)//stride
            off,mask = legacy_offsets(om[:,:18],om[:,18:].sigmoid(),h,w) if stride>1 else (om[:,:18].contiguous(),om[:,18:].sigmoid())
            y = deform_conv2d(y,off,self.s[name+'.conv2.weight'],stride=(stride,stride),padding=(1,1),mask=mask)
        else:
            y = self.conv(y,name+'.conv2',stride=stride,padding=1)
        y = F.relu(self.bn(y,name+'.bn2'))
        y = self.bn(self.conv(y,name+'.conv3'),name+'.bn3')
        if name+'.downsample.0.weight' in self.s:
            skip = self.bn(self.conv(skip,name+'.downsample.0',stride=stride),name+'.downsample.1')
        return F.relu(y+skip)

    @torch.inference_mode()
    def __call__(self, image):
        x = image.to(self.device)
        x = F.max_pool2d(F.relu(self.bn(self.conv(x,'backbone.conv1',2,3),'backbone.bn1')),3,2,1)
        features=[]
        for stage, count in enumerate((3,4,6,3),1):
            for block in range(count):
                x=self.block(x,f'backbone.layer{stage}.{block}',2 if stage>1 and block==0 else 1,stage>1)
            features.append(x)
        levels=[self.conv(x,f'decoder.in{i+2}') for i,x in enumerate(features)]
        for i in (2,1,0):
            levels[i]=levels[i]+F.interpolate(levels[i+1],scale_factor=2,mode='nearest')
        parts=[]
        for i in (3,2,1,0):
            p=self.conv(levels[i],f'decoder.out{i+2}'+('.0' if i else ''),padding=1)
            parts.append(F.interpolate(p,scale_factor=2**i,mode='nearest') if i else p)
        a='decoder.concat_attention'
        x=self.conv(torch.cat(parts,1),a+'.conv',padding=1)
        a += '.enhanced_attention'
        channel=self.conv(F.relu(self.conv(F.adaptive_avg_pool2d(x,1),a+'.channel_wise.1')),a+'.channel_wise.3').sigmoid()
        x=x+channel
        spatial=self.conv(F.relu(self.conv(x.mean(dim=1,keepdim=True),a+'.spatial_wise.0',padding=1)),a+'.spatial_wise.2').sigmoid()
        scores=self.conv(x+spatial,a+'.attention_wise.0').sigmoid()
        x=torch.cat([p*scores[:,i:i+1] for i,p in enumerate(parts)],1)
        x=F.relu(self.bn(self.conv(x,'decoder.binarize.0',padding=1),'decoder.binarize.1'))
        x=F.conv_transpose2d(x,self.s['decoder.binarize.3.weight'],self.s['decoder.binarize.3.bias'],stride=2)
        x=F.relu(self.bn(x,'decoder.binarize.4'))
        return F.conv_transpose2d(x,self.s['decoder.binarize.6.weight'],self.s['decoder.binarize.6.bias'],stride=2).sigmoid()
