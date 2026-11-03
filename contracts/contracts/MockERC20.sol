// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title 测试用 ERC20 代币
/// @notice 除了标准 ERC20 接口外，提供 faucet() 让每个地址领取固定数量的测试代币。
/// @dev mint() 完全开放，仅供本地测试与模拟脚本使用，正式链上不应这样部署。
contract MockERC20 is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000 ether;
    /// @notice 同一地址两次领取之间的最小间隔
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    mapping(address => uint256) public lastFaucetAt;

    event FaucetClaimed(address indexed user, uint256 amount);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice 领取测试代币，每个地址每隔 FAUCET_COOLDOWN 可以领一次
    function faucet() external returns (uint256 amount) {
        uint256 last = lastFaucetAt[msg.sender];
        require(last == 0 || block.timestamp >= last + FAUCET_COOLDOWN, "MockERC20: faucet cooldown");

        lastFaucetAt[msg.sender] = block.timestamp;
        amount = FAUCET_AMOUNT;
        _mint(msg.sender, amount);

        emit FaucetClaimed(msg.sender, amount);
    }

    /// @notice 供模拟脚本批量发币（本地测试环境专用）
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
